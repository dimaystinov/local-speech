// Local benchmark worker for the installed NeMo-Speech.cpp v0.2.0 C ABI.
// stdin: path to raw mono 16 kHz float32 audio. stdout: seconds<TAB>first-fed-seconds<TAB>hex UTF-8.
#include <nemo_speech/asr.h>
#include <chrono>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>
#include <stdexcept>

void check(nemo_speech_asr_status s) {
    if (s != NEMO_SPEECH_ASR_OK) throw std::runtime_error(nemo_speech_asr_last_error());
}
int main(int argc, char** argv) {
    try {
        if (argc != 2) throw std::runtime_error("Expected local GGUF path");
        nemo_speech_asr_backend_config backend{sizeof(backend), 0};
        nemo_speech_asr_model_config model{sizeof(model), argv[1], nullptr};
        nemo_speech_asr_streaming_config policy{sizeof(policy), 0.16f, 1.92f, 0, 3};
        nemo_speech_asr_batching_config batching{}; batching.size = sizeof(batching); batching.enable = false;
        nemo_speech_asr_recognizer_config cfg{};
        cfg.size = sizeof(cfg); cfg.backend = &backend; cfg.model = &model;
        cfg.streaming = &policy; cfg.batching = &batching;
        nemo_speech_asr_recognizer* recognizer = nullptr;
        check(nemo_speech_asr_create(&cfg, &recognizer));
        auto options = nemo_speech_asr_recognition_options_default();
        options.language_code = "auto"; options.interim_results = true;
        options.enable_automatic_punctuation = false; options.verbatim_transcripts = true;
        std::cout << "READY" << std::endl;
        std::string path;
        while (std::getline(std::cin, path)) {
            std::ifstream input(path, std::ios::binary | std::ios::ate);
            if (!input) throw std::runtime_error("Cannot read audio");
            auto bytes = input.tellg();
            if (bytes <= 0 || bytes % 4 != 0) throw std::runtime_error("Invalid float32 file");
            std::vector<float> audio(static_cast<size_t>(bytes) / 4);
            input.seekg(0); input.read(reinterpret_cast<char*>(audio.data()), bytes);
            auto start = std::chrono::steady_clock::now();
            nemo_speech_asr_stream* stream = nullptr;
            check(nemo_speech_asr_streaming_recognize(recognizer, &options, &stream));
            std::string text; double first = -1;
            auto drain = [&](double fed) {
                for (;;) {
                    nemo_speech_asr_result* result = nullptr;
                    check(nemo_speech_asr_stream_next(stream, &result));
                    if (!result) break;
                    const char* phrase = nemo_speech_asr_result_transcript(result, 0);
                    if (phrase && phrase[0] && first < 0) first = fed;
                    if (nemo_speech_asr_result_is_final(result) && phrase) {
                        if (!text.empty()) text += " "; text += phrase;
                    }
                    nemo_speech_asr_result_destroy(result);
                }
            };
            for (size_t i = 0; i < audio.size(); i += 5120) {
                size_t count = std::min(size_t(5120), audio.size() - i);
                check(nemo_speech_asr_stream_push_f32(stream, audio.data() + i, count, 16000));
                drain(double(i + count) / 16000);
            }
            check(nemo_speech_asr_stream_finish(stream)); drain(double(audio.size()) / 16000);
            nemo_speech_asr_stream_close(stream);
            double elapsed = std::chrono::duration<double>(std::chrono::steady_clock::now() - start).count();
            static const char* hex = "0123456789abcdef";
            std::cout << elapsed << '\t' << first << '\t';
            for (unsigned char c : text) std::cout << hex[c >> 4] << hex[c & 15];
            std::cout << std::endl;
        }
        nemo_speech_asr_destroy(recognizer);
    } catch (const std::exception& error) {
        std::cerr << error.what() << std::endl; return 1;
    }
}
