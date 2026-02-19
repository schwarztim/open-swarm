# Swarm Orchestrator — Copilot CLI Skill

A multi-agent orchestration skill for [GitHub Copilot CLI](https://docs.github.com/copilot/concepts/agents/about-copilot-cli) based on the cooperative dynamics described in [*"Multi-agent cooperation through in-context co-player inference"*](https://arxiv.org/abs/2602.16301) (Wołczyk, Weis, Nasser et al., 2026).

## What It Does

Spawns diverse agent swarms that **adapt through interaction history** and **cooperatively converge** on optimal solutions via mutual shaping — not centralized control.

The key insight from the paper: **cooperation emerges naturally** when you combine:
1. **Agent diversity** — different models, roles, and reasoning biases
2. **Anonymous interaction history** — agents infer co-player strategy from content, not labels
3. **Quality scoring** — creates the gradient pressure that drives improvement
4. **Mutual shaping** — bidirectional critique where agents shape each other toward quality

## Tiered Modes

| Mode | Agents | Use When |
|------|--------|----------|
| **Duo** | 2 | Simple implementation + review |
| **Trio** | 3 | Multi-file feature needing design + code + validation |
| **Full Swarm** | 5-6 | Complex architecture, security-critical changes |
| **Debate** | N+1 | Design decisions, architecture choices |

## Installation

Copy `SKILL.md` into your Copilot CLI skills directory:

```bash
mkdir -p ~/.copilot/skills/swarm-orchestrator
cp SKILL.md ~/.copilot/skills/swarm-orchestrator/SKILL.md
```

Restart Copilot CLI. The skill will appear in `/skills`.

## Three Rules (violating any one causes failure)

These come directly from the paper's ablation experiments:

1. **Use diverse models** — Same model for all agents → agreeable mediocre output
2. **Keep history anonymous** — Never label contributions with role names
3. **Pass full history** — Every agent gets the complete interaction sequence

## Paper Reference

> Wołczyk, M., Weis, M.A., Nasser, R., Saurous, R.A., Agüera y Arcas, B., Sacramento, J., & Meulemans, A. (2026). *Multi-agent cooperation through in-context co-player inference*. arXiv:2602.16301.

The paper demonstrates that in multi-agent reinforcement learning, training sequence model agents against a diverse pool of co-players naturally induces in-context best-response strategies. Agents become vulnerable to shaping through their adaptiveness, and mutual shaping pressure between agents resolves into cooperative behavior — without explicit meta-learning or centralized coordination.

## License

MIT
