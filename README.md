# Rhythm Agentic AI · Voice Run Viewer (prototype)

Interactive prototype of a cardiac voice-run console with a guardrail harness, patterned on Rhythm's public Agentic AI language (myrhythmnow.com) and the Product Manager - Agentic role.

The walkthrough shows one non-negotiable safety loop:

1. Call event: monitor disconnected, outbound agent call on a branded line
2. Agent turns and tool actions (device status lookup, SMS outreach)
3. Guardrail trip on an urgent patient utterance: rule name + cited transcript span
4. Mandatory escalate-to-human: the agent cannot continue alone
5. Clinician override records the handoff
6. Next clinic action queued on the worklist

Two synthetic scenarios:

- **Monitor disconnected · urgent symptom** — guardrail trips, escalation required
- **Connectivity fix · routine** — contained run, no trip, auto-close

## Run locally

```
python3 -m http.server 8000
```

Then open http://127.0.0.1:8000/

## Notes

- Synthetic patient data only: no live telephony, no accounts, no PHI.
- Responsive: single-column phone layout with touch-sized controls; three-column console on desktop.