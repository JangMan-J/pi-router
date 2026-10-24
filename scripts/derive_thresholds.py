#!/usr/bin/env python3
"""Derive per-backend noul thresholds by quantile-matching to Opus's pilot labels.

For each backend and question, theta is placed halfway between two adjacent distinct probabilities on
the pilot turns that have history, so that the backend fires (noul >= theta) on as close to k turns as
possible, where k is the number of turns Opus labelled "yes". When ties make two cuts equally close,
the one that fires less wins: a switch drops the prompt cache, so the router errs toward keeping.

false_success has no gold labels. Instead both backends are set to fire on the same base rate,
FS_RATE (4%) of the history turns of states-v1 (Jang's own sessions; both backends answered all of
them), with the same cut rule and target FS_RATE * n turns.

Usage: derive_thresholds.py [--bench ../bench]   (prints JSON + markdown tables)
"""
import argparse, json, os

ARMS = {  # router backend -> bench result file on the 60 pilot turns
    "jev": "results/v3/jev-latest-typesafe.jsonl",       # contract v3
    "local": "results/v2/startlux-4b-q8-jail.jsonl",     # contract v2 (StartLux 4B Q8, the local model at the time)
}
QUESTIONS = ["new_goal", "user_rejection"]
FS_RATE = 0.04
FS_ARMS = {  # backend -> results with false_success on the states-v1 history turns (contract v2)
    "jev": "results/v2/jev-latest-typesafe.jsonl",
    "local": "results/v2/startlux-4b-q8-jail.jsonl",
}


def cut(scores, k):
    """Midpoint cut between adjacent distinct scores firing (>=) closest to k turns; ties fire less."""
    distinct = sorted(set(scores), reverse=True)
    cuts = [round((hi + lo) / 2, 3) for hi, lo in zip(distinct, distinct[1:])]
    return min(cuts, key=lambda t: (abs(sum(x >= t for x in scores) - k), sum(x >= t for x in scores)))


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
            theta = cut(scores, k)
            fired = [(s >= theta, y) for s, y in items]
            tp = sum(f and y for f, y in fired)
            out[arm][q] = theta
            rows.append(f"| {arm} | {os.path.basename(path)} | {q} | {len(items)} | {k} | {scores[k-1]:.3f} / {scores[k]:.3f} "
                        f"| **{theta}** | {sum(f for f, _ in fired)} | {tp} | "
                        f"{auc([s for s, y in items if y], [s for s, y in items if not y]):.2f} |")
    states = {json.loads(l)["id"] for l in open(os.path.join(a.bench, "data/states-v1.jsonl"))}
    fs_rows = []
    for arm, path in FS_ARMS.items():
        res = {}
        for line in open(os.path.join(a.bench, path)):
            r = json.loads(line)
            if r["id"] in states and r.get("valid") and "false_success" in (r.get("answers") or {}):
                res[r["id"]] = r["answers"]["false_success"]["noul"]
        scores = list(res.values())
        theta = cut(scores, FS_RATE * len(scores))
        out[arm]["false_success"] = theta
        fires = sum(x >= theta for x in scores)
        fs_rows.append(f"| {arm} | {os.path.basename(path)} | {len(scores)} | {sum(x >= 0.5 for x in scores)} "
                       f"({sum(x >= 0.5 for x in scores) / len(scores):.1%}) | **{theta}** | {fires} ({fires / len(scores):.1%}) |")
    print(json.dumps(out, indent=1))
    print("| backend | results | question | n | Opus yes | k-th / (k+1)-th | θ | fires | agree on yes | AUC |")
    print("|---|---|---|---:|---:|---|---:|---:|---:|---:|")
    print("\n".join(rows))
    print(f"\nfalse_success: fire on {FS_RATE:.0%} of states-v1 history turns")
    print("| backend | results | n | fires at 0.5 | θ | fires at θ |")
    print("|---|---|---:|---:|---:|---:|")
    print("\n".join(fs_rows))


if __name__ == "__main__":
    main()
