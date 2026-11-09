#!/usr/bin/env python3
"""Rebuild a separate score from cached YourMT3 events, without running models."""
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server.score_rebuild import rebuild


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('analysis_directory', type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--exact', action='store_true', help='Use bounded performance timing instead of musical notation inference')
    args = parser.parse_args()
    audit_path = args.output.with_suffix('.evidence.json')
    if args.output.exists() or audit_path.exists():
        parser.error('Choose new output paths; existing scores and evidence are never overwritten')
    project, audit = rebuild(args.analysis_directory, exact=args.exact)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(project, ensure_ascii=False, indent=2) + '\n')
    audit_path.write_text(json.dumps(audit, ensure_ascii=False, indent=2) + '\n')
    print(f"Saved {sum(len(p['notes']) for p in project['parts'])} notes to {args.output}")
