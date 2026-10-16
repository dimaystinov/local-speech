"""Summarize identical paired pilot evaluations; reject incomplete or mismatched reports."""
import argparse
import json
import math
from pathlib import Path


def percentile(values, fraction):
    return sorted(values)[max(0, math.ceil(len(values) * fraction) - 1)]


def summarize(report):
    if not report.get('complete') or not report.get('rows'):
        raise ValueError('Incomplete report')
    groups = {}
    conditions = {}
    times = []
    audio = 0
    for row in report['rows']:
        group = groups.setdefault(row['language'], dict(files=0, errors=0, words=0, terms=0, matchedTerms=0))
        group['files'] += 1
        for key in ('errors', 'words', 'terms', 'matchedTerms'):
            group[key] += row[key]
        times.extend(row['chunkSeconds'])
        audio += row['audioSeconds']
        condition = conditions.setdefault(row['language'] + '/' + row['variant'], dict(errors=0, words=0))
        condition['errors'] += row['errors']
        condition['words'] += row['words']
    for group in groups.values():
        group['werPercent'] = 100 * group['errors'] / group['words']
        group['termRecallPercent'] = 100 * group['matchedTerms'] / group['terms'] if group['terms'] else None
    for condition in conditions.values():
        condition['werPercent'] = 100 * condition['errors'] / condition['words']
    return dict(groups=groups, conditions=conditions, bundleMB=report['modelBytes'] / 1e6,
                chunkMedianSeconds=percentile(times, .5), chunkP95Seconds=percentile(times, .95),
                rtf=sum(times) / audio, loadSeconds=report['loadSeconds'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    parser.add_argument('reports', nargs='+')
    args = parser.parse_args()
    reports = {name: json.loads((args.directory / name).read_text()) for name in args.reports}
    first = next(iter(reports.values()))
    identity = [(r['id'], r['reference']) for r in first['rows']]
    for report in reports.values():
        if report['chunkWindowSeconds'] != first['chunkWindowSeconds'] or identity != [
                (r['id'], r['reference']) for r in report['rows']]:
            raise ValueError('Mismatched benchmark conditions')
    summaries = {name: summarize(report) for name, report in reports.items()}
    if 'tiny.json' in reports and 'tuned.json' in reports:
        base, tuned = summaries['tiny.json'], summaries['tuned.json']
        gates = {
            'mixedRelativeWER10Percent': tuned['groups']['mixed']['errors'] <= .9 * base['groups']['mixed']['errors'],
            'noRUErrorsIncrease': tuned['groups']['ru']['errors'] <= base['groups']['ru']['errors'],
            'noENErrorsIncrease': tuned['groups']['en']['errors'] <= base['groups']['en']['errors'],
            'noTermRecallDecrease': tuned['groups']['mixed']['matchedTerms'] >= base['groups']['mixed']['matchedTerms'],
            'p95Within10Percent': tuned['chunkP95Seconds'] <= 1.1 * base['chunkP95Seconds'],
        }
        summaries['pilotGates'] = gates
        summaries['decision'] = 'larger-independent-test-required' if all(gates.values()) else 'do-not-promote'
        summaries['paired'] = {
            'improved': sum(b['errors'] < a['errors'] for a, b in zip(reports['tiny.json']['rows'], reports['tuned.json']['rows'])),
            'regressed': sum(b['errors'] > a['errors'] for a, b in zip(reports['tiny.json']['rows'], reports['tuned.json']['rows'])),
        }
    print(json.dumps(summaries, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
