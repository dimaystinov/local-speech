/* Native capture -> our packaged browser SDK. No alternate recognition engine. */
(function (root) {
  'use strict';
  const MAX_PENDING = 150;
  const STOP_DRAIN_MS = 8000;
  const CHANNELS = new Set(['microphone', 'call']);
  let generation = 0;
  let active = null;
  let stopping = null;

  function send(message) {
    const status = root.document?.getElementById('status');
    if (status && ['boot', 'ready', 'stopped', 'failure'].includes(message.type)) {
      status.textContent = message.message || ({boot: 'SDK готов к загрузке модели', ready: 'Распознавание готово', stopped: 'Остановлено'}[message.type]);
    }
    root.webkit?.messageHandlers?.speech?.postMessage(message);
  }
  const current = session => active === session && !session.closed && session.generation === generation;
  const messageOf = error => error instanceof Error ? error.message : String(error);

  function disposeAll(session) {
    if (!session.cleanup) {
      session.cleanup = Promise.allSettled([...session.entries.values()].map(entry => {
        // dispose cancels an in-progress model load and releases its worker.
        try { return entry.client.dispose(); } catch (error) { return Promise.reject(error); }
      })).then(results => {
        for (const entry of session.entries.values()) entry.unsubscribe?.();
        return results;
      });
    }
    return session.cleanup;
  }

  function fail(session, error) {
    if (!current(session)) return session.cleanup || Promise.resolve();
    session.closed = true;
    ++generation;
    send({type: 'failure', message: messageOf(error)});
    return Promise.all([disposeAll(session),root.CallSpeakers?.finish(session.speakers)]).then(() => { if (active === session) active = null; });
  }

  function validateOptions(options) {
    if (!options || !['mixed', 'ru', 'en'].includes(options.language)) throw Error('Unsupported recognition language');
    if (!Array.isArray(options.channels) || !options.channels.length || options.channels.length > 2 ||
        new Set(options.channels).size !== options.channels.length || options.channels.some(channel => !CHANNELS.has(channel))) {
      throw Error('Expected unique microphone and/or call channels');
    }
    if (options.allowLargeModels !== undefined && typeof options.allowLargeModels !== 'boolean') throw Error('allowLargeModels must be boolean');
    if (typeof options.cacheOnly !== 'boolean') throw Error('cacheOnly must be boolean');
    if (!Array.isArray(options.terms) || options.terms.length > 32 || options.terms.some(term =>
      typeof term !== 'string' || !term.trim() || term.length > 80 || /[\u0000-\u001f\u007f]/.test(term))) {
      throw Error('Expected at most 32 non-empty context terms');
    }
  }

  async function prepare(options) {
    if (active || stopping) {
      const error = Error('Stop the current session before preparing again');
      if (active && current(active)) await fail(active, error);
      else send({type: 'failure', message: error.message});
      return false;
    }
    try {
      validateOptions(options);
      if (!root.LocalSpeech?.create) throw Error('LocalSpeech SDK was not loaded');
    } catch (error) { send({type: 'failure', message: messageOf(error)}); return false; }
    const session = {generation: ++generation, closed: false, phase: 'preparing', entries: new Map()};
    active = session;
    session.speakers = root.CallSpeakers?.start({enabled: options.speakerEnabled === true, profiles: options.voiceProfiles || []});
    try {
      for (const channel of options.channels) {
        if (!current(session)) return false;
        const client = root.LocalSpeech.create({
          assetBaseURL: new URL('/sdk/', root.location.href).href,
          maxSegmentSeconds: 6,
          language: options.language, terms: options.terms.slice(), cacheOnly: options.cacheOnly,
          ...(options.allowLargeModels !== undefined ? {allowLargeModels: options.allowLargeModels} : {}),
          ...(options.deviceHints ? {deviceHints: options.deviceHints} : {}),
        });
        const entry = {client, tail: Promise.resolve(), pending: 0, rate: null, packetIds: new Set()};
        session.entries.set(channel, entry);
        entry.unsubscribe = client.on('*', event => {
          if (!current(session)) return;
          send({type: 'event', channel, event});
          if(event.type==='final')root.CallSpeakers?.final(session.speakers,channel,event);
          if (event.type === 'error') void fail(session, Error(event.message || 'Recognition failed'));
        });
        await client.prepare({input: 'pcm'});
        if (!current(session)) return false;
        await client.start({input: 'pcm'});
        if (!current(session)) return false;
      }
      session.phase = 'ready';
      send({type: 'ready'});
      return true;
    } catch (error) {
      await fail(session, error);
      return false;
    }
  }

  function decodePCM(encoded, rate) {
    if (!Number.isInteger(rate) || rate < 8000 || rate > 96000) throw Error('PCM sample rate must be 8000..96000 Hz');
    // Reject over-sized input before decoding or allocating sample buffers.
    if (typeof encoded !== 'string' || !encoded.length || encoded.length > Math.ceil(rate * 4 / 3) * 4 ||
        encoded.length % 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      throw Error('Invalid or oversized base64 PCM');
    }
    const decoded = root.atob(encoded);
    if (!decoded.length || decoded.length % 4 || decoded.length > rate * 4) throw Error('Expected at most one second of Float32 PCM');
    const bytes = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
    const view = new DataView(bytes.buffer);
    const samples = new Float32Array(decoded.length / 4);
    for (let i = 0; i < samples.length; i++) {
      const value = view.getFloat32(i * 4, true);
      if (!Number.isFinite(value) || Math.abs(value) > 1) throw Error('PCM samples must be finite and normalized');
      samples[i] = value;
    }
    return samples;
  }

  function audio(channel, encoded, rate, packetId) {
    const session = active;
    if (!session || !current(session)) return Promise.resolve(false);
    try {
      if (session.phase !== 'ready') throw Error('Session is not accepting audio');
      const entry = session.entries.get(channel);
      if (!entry) throw Error('Unknown audio channel');
      if (!(Number.isSafeInteger(packetId) && packetId >= 0) && !(typeof packetId === 'string' && packetId.length > 0 && packetId.length <= 100)) throw Error('Invalid packet ID');
      if (entry.packetIds.has(packetId)) throw Error('Duplicate pending packet ID');
      if (entry.pending >= MAX_PENDING) throw Error(`Audio queue overflow for ${channel}`);
      if (entry.rate !== null && entry.rate !== rate) throw Error('Sample rate cannot change during a session');
      const samples = decodePCM(encoded, rate);
      entry.rate = rate;
      entry.pending++;
      root.CallSpeakers?.pressure?.(session.speakers,channel,{busy:entry.busy===true,pending:entry.pending});
      entry.packetIds.add(packetId);
      const job = entry.tail.then(async () => {
        if (!current(session)) return false;
        root.CallSpeakers?.feed(session.speakers,channel,samples,rate);
        entry.busy=true;
        root.CallSpeakers?.pressure?.(session.speakers,channel,{busy:true,pending:entry.pending});
        try { await entry.client.write(samples, rate, {pendingPackets: entry.pending}); }
        finally { entry.busy=false; root.CallSpeakers?.pressure?.(session.speakers,channel,{busy:false,pending:entry.pending}); }
        if (!current(session)) return false;
        send({type: 'ack', channel, packetId});
        return true;
      }).catch(async error => { await fail(session, error); return false; }).finally(() => {
        entry.pending--;
        root.CallSpeakers?.pressure?.(session.speakers,channel,{busy:entry.busy===true,pending:entry.pending});
        entry.packetIds.delete(packetId);
      });
      entry.tail = job;
      return job;
    } catch (error) { return fail(session, error).then(() => false); }
  }

  function stop() {
    if (stopping) return stopping;
    const session = active;
    if (!session) { send({type: 'stopped'}); return Promise.resolve(); }
    const wasPreparing = session.phase === 'preparing';
    session.phase = 'stopping';
    if (wasPreparing && current(session)) { session.closed = true; ++generation; }
    const job = (async () => {
      try {
        if (!wasPreparing && current(session)) {
          // Recovery may be loading/replaying a fallback. Do not wait for its
          // 90-second budget before giving dispose() a chance to cancel it.
          let drainTimer;
          try {
            await Promise.race([
              Promise.all([...session.entries.values()].map(entry => entry.tail)),
              new Promise((_, reject) => { drainTimer = setTimeout(() => {
                const pressure = [...session.entries].map(([channel, entry]) => `${channel}: ${entry.pending} packets, ${entry.client.state || 'unknown'}`).join('; ');
                reject(Error(`Audio tail did not drain within 8 seconds (${pressure}). Unprocessed audio was cancelled; completed text is preserved.`));
              }, STOP_DRAIN_MS); }),
            ]);
          } finally { clearTimeout(drainTimer); }
          // Keep callbacks live through stop(): it emits the final buffered phrase.
          // Channels have separate workers. Flush them concurrently so their
          // individual 15-second model deadlines do not accumulate past the host deadline.
          await Promise.all([...session.entries].map(async ([channel, entry]) => {
            if (!current(session)) return;
            entry.busy=true;root.CallSpeakers?.pressure?.(session.speakers,channel,{busy:true,pending:entry.pending});
            try { await entry.client.stop(); }
            finally { entry.busy=false;root.CallSpeakers?.pressure?.(session.speakers,channel,{busy:false,pending:0}); }
          }));
        }
      } catch (error) { await fail(session, error); }
      await root.CallSpeakers?.finish(session.speakers);
      session.closed = true;
      if (active === session) ++generation;
      const disposed = await disposeAll(session);
      const rejected = disposed.find(result => result.status === 'rejected');
      if (rejected) send({type: 'failure', message: `Cleanup failed: ${messageOf(rejected.reason)}`});
      if (active === session) active = null;
      send({type: 'stopped'});
    })();
    stopping = job;
    job.finally(() => { if (stopping === job) stopping = null; }).catch(() => {});
    return job;
  }

  root.CallBridge = Object.freeze({prepare, audio, stop, enroll: options => root.CallSpeakers?.enroll(options), cancelEnrollment: id => root.CallSpeakers?.cancelEnrollment(id)});
  send({type: 'boot', sdkVersion: root.LocalSpeech?.version || null});
})(globalThis);
