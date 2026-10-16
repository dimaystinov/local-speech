"""Bounded glossary-triggered acoustic review, never dictionary-only replacement.

Aliases are caller-supplied pronunciations, not mined from evaluation references.
Only exact token sequences trigger review, independent of ASR confidence. A second
ASR must independently emit the corresponding canonical term for a patch.
"""
import re

def tokens(text):
    return re.findall(r'[^\W_]+',text.lower().replace('ё','е'),re.UNICODE)

def compile_glossary(entries):
    if not isinstance(entries,list) or len(entries)>64:raise ValueError('At most 64 glossary terms')
    result=[];owners={}
    for entry in entries:
        term=entry.get('term','');aliases=entry.get('aliases',[])
        if not isinstance(term,str) or len(term)>80 or not re.fullmatch(r'[A-Za-z][A-Za-z0-9 .+#-]*',term):raise ValueError('Invalid canonical term')
        if not isinstance(aliases,list) or not 1<=len(aliases)<=8:raise ValueError('Invalid aliases')
        canonical=tuple(tokens(term))
        for alias in aliases:
            if not isinstance(alias,str) or len(alias)>100:raise ValueError('Invalid alias')
            sequence=tuple(tokens(alias))
            if not sequence or len(sequence)>4 or not re.search('[а-яё]',alias.lower()):raise ValueError('Cyrillic pronunciation required')
            if sequence in owners and owners[sequence]!=canonical:raise ValueError('Ambiguous alias')
            owners[sequence]=canonical
            result.append((sequence,canonical))
    return tuple(result)

def matches(text,entries):
    tt=tokens(text);result=[]
    for alias,canonical in compile_glossary(entries):
        for i in range(len(tt)-len(alias)+1):
            if tuple(tt[i:i+len(alias)])==alias:result.append((i,i+len(alias),canonical))
    return result

def confirms(source,candidate,entries):
    src=tuple(tokens(source));target=tuple(tokens(candidate))
    # Require an actual Latin rendering, not its phonetic Cyrillic counterpart.
    if not re.search('[A-Za-z]',candidate) or re.search('[а-яё]',candidate.lower()):return False
    return any(src==alias and target==canonical for alias,canonical in compile_glossary(entries))

def confirmed_edits(original,candidate,entries):
    """Isolate unique confirmed terms inside larger rewrites; keep all neighbours.

Require a shared nearby lexical anchor and small positional drift. Ambiguous
repeated terms are left alone. Canonical spacing can be recovered from Latin-only
Qwen tokens (e.g. Git Hub -> GitHub), but never from Qwen Cyrillic alone.
"""
    aa=list(re.finditer(r'[^\W_]+',original,re.UNICODE));bb=list(re.finditer(r'[^\W_]+',candidate,re.UNICODE))
    at=tokens(original);bt=tokens(candidate);edits=[]
    seen=set()
    for start,end,canonical in matches(original,entries):
        key=(start,end,canonical)
        if key in seen:continue
        seen.add(key)
        if sum(x[2]==canonical for x in set(matches(original,entries)))!=1:continue
        target=''.join(canonical);occurrences=[]
        for k in range(len(bb)):
            for l in range(k+1,min(len(bb),k+4)+1):
                value=candidate[bb[k].start():bb[l-1].end()]
                if ''.join(bt[k:l])==target and re.search('[A-Za-z]',value) and not re.search('[а-яё]',value.lower()):occurrences.append((k,l))
        if len(occurrences)!=1:continue
        k,l=occurrences[0]
        left=set(at[max(0,start-3):start]) & set(bt[max(0,k-3):k])
        right=set(at[end:end+3]) & set(bt[l:l+3])
        if abs(k-start)>3 or not (left or right):continue
        entry=next(e for e in entries if tuple(tokens(e['term']))==canonical)
        edits.append((aa[start].start(),aa[end-1].end(),entry['term']))
    return edits
