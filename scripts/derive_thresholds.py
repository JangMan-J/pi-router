#!/usr/bin/env python3
"""Derive per-backend noul thresholds by quantile-matching to Opus's pilot labels.

For each backend and question, theta is placed halfway between two adjacent distinct probabilities on
the pilot turns that have history, so that the backend fires (noul >= theta) on as close to k turns as
possible, where k is the number of turns Opus labelled "yes". When ties make two cuts equally close,
the one that fires less wins: a switch drops the prompt cache, so the router errs toward keeping.

Usage: derive_thresholds.py [--bench ../bench]   (prints JSON + a markdown table)
"""
import argparse, json, os

ARMS = {  # router backend -> bench result file on the 60 pilot turns
    "jev": "results/v3/jev-latest-typesafe.jsonl",       # contract v3
    "local": "results/v2/startlux-4b-q8-jail.jsonl",     # contract v2 (StartLux 4B Q8, the local model at the time)
}
QUESTIONS = ["new_goal", "user_rejection"]


def auc(pos, neg):
    if not pos or not neg:
        return None
    wins = sum((p > n) + 0.5 * (p == n) for p in pos for n in neg)
    return wins / (len(pos) * len(neg))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bench", default=os.path.join(os.path.dirname(__file__), "..", "..", "bench"))
    a = ap.parse_args()
    gold = {}
    for line in open(os.path.join(a.bench, "gold/pilot-v1.claude-opus-5-5-max.jsonl")):
        r = json.loads(line)
        gold[r["id"]] = r["labels"]
    out, rows = {}, []
    for arm, path in ARMS.items():
        res = {}
        for line in open(os.path.join(a.bench, path)):
            r = json.loads(line)
            if r["id"] in gold and r.get("valid"):
                res[r["id"]] = r["answers"]  # last valid row wins
        out[arm] = {}
        for q in QUESTIONS:
            items = [(res[i][q]["noul"], gold[i][q] == "yes") for i in gold
                     if gold[i].get(q) in ("yes", "no") and i in res and q in res[i]]
            k = sum(y for _, y in items)
            scores = sorted((s for s, _ in items), reverse=True)
            distinct = sorted(set(scores), reverse=True)
            cuts = [round((hi + lo) / 2, 3) for hi, lo in zip(distinct, distinct[1:])]
            theta = min(cuts, key=lambda t: (abs(sum(x >= t for x in scores) - k), sum(x >= t for x in scores)))
            fired = [(s >= theta, y) for s, y in items]
            tp = sum(f and y for f, y in fired)
            out[arm][q] = theta
            rows.append(f"| {arm} | {os.path.basename(path)} | {q} | {len(items)} | {k} | {scores[k-1]:.3f} / {scores[k]:.3f} "
                        f"| **{theta}** | {sum(f for f, _ in fired)} | {tp} | "
                        f"{auc([s for s, y in items if y], [s for s, y in items if not y]):.2f} |")
    print(json.dumps(out, indent=1))
    print("| backend | results | question | n | Opus yes | k-th / (k+1)-th | θ | fires | agree on yes | AUC |")
    print("|---|---|---|---:|---:|---|---:|---:|---:|---:|")
    print("\n".join(rows))


if __name__ == "__main__":
    main()
