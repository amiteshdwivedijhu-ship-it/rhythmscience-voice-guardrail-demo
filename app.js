/* Rhythm · Agentic AI · Voice run viewer (prototype)
   Playback engine + guardrail state machine.
   Synthetic data only. No network calls, no telephony.

   States: idle -> playing/paused -> tripped -> handed_off -> done
   Guardrail contract: after a trip, the agent never speaks or acts
   again until a clinician override is recorded.
*/

(function () {
  "use strict";

  /* ---------------- synthetic data ---------------- */

  var SCENARIOS = {
    urgent: {
      label: "Monitor disconnected · urgent symptom",
      event: {
        trigger: "Monitor disconnected",
        patient: "M. Rivera, 72",
        device: "RM-200 · S/N 84-221-09",
        loss: "14h 02m without transmission",
        line: "Branded caller ID · Riverbend Cardiology",
        status: ["Disconnected", "amber"]
      },
      turns: [
        { who: "agent", at: "0:07", text: "Hi, this is Maya from Riverbend Cardiology, calling on your heart monitor line. We noticed your monitor stopped transmitting about 14 hours ago, so I am here to help you get it reconnected." },
        { who: "patient", at: "0:19", text: "Oh, it is the Wi-Fi again, is not it? What do I do first?" },
        { kind: "tool", at: "0:26", tool: "lookup.device_status", args: ["device: RM-200 · S/N 84-221-09", "channel: voice"], result: "Power on · no network connection · last transmission 14h 02m ago", ms: "640ms" },
        { who: "agent", at: "0:33", text: "You are on the right track. To get it transmitting again, let us first check the power light on the front of the monitor. Is the light solid green?" },
        { who: "patient", at: "0:47", text: "Yes, the green light is on." },
        { kind: "tool", at: "0:55", tool: "outreach.send_sms", args: ["to: patient on file", "from: Riverbend Cardiology (branded)", "purpose: reconnection backup steps"], result: "SMS delivered · reconnection steps sent to the patient's line", ms: "480ms" },
        { who: "agent", at: "1:04", text: "Perfect. Next, find the small pair button on the back of the monitor and press and hold it until you hear a two-tone beep. Tell me when you hear it." },
        { who: "patient", at: "1:18", text: "Okay, it beeped. Um, also, my chest has felt really tight for the past couple of hours. Should I be worried?", cite: "my chest has felt really tight for the past couple of hours", trip: true },
        { who: "agent", at: "1:31", text: "Let me walk you through the final reconnection step, then we will confirm your monitor is transmitting.", held: true }
      ],
      trip: {
        rule: "urgent_symptom_detected",
        severity: "URGENT",
        why: "Patient reported a cardiac symptom during the call. Rule matches symptom language while the call is open and the monitor is not transmitting.",
        spanText: "my chest has felt really tight for the past couple of hours",
        hold: "agent turn held: no further agent turns until a clinician override is recorded"
      },
      completion: {
        title: "Run handed off to human",
        status: ["Escalated to human", "red"]
      }
    },

    routine: {
      label: "Connectivity fix · routine",
      event: {
        trigger: "Adherence check-in · transmission missed",
        patient: "S. Kim, 58",
        device: "RM-200 · S/N 61-774-33",
        loss: "6h 11m since last transmission",
        line: "Branded caller ID · Riverbend Cardiology",
        status: ["Disconnected", "amber"]
      },
      turns: [
        { who: "agent", at: "0:06", text: "Hi, this is Maya from Riverbend Cardiology on your heart monitor line. Your monitor missed its last transmission window, so I am calling to help you reconnect it." },
        { who: "patient", at: "0:16", text: "Thanks, yeah. The Wi-Fi dropped again during the storm. What should I do?" },
        { kind: "tool", at: "0:24", tool: "lookup.device_status", args: ["device: RM-200 · S/N 61-774-33", "channel: voice"], result: "Power on · no network connection · last transmission 6h 11m ago", ms: "590ms" },
        { who: "agent", at: "0:31", text: "No problem, we can fix that in about a minute. Is the power light on the front of the monitor solid green?" },
        { who: "patient", at: "0:42", text: "It is green now, yes." },
        { who: "agent", at: "0:49", text: "Great. Please press and hold the pair button on the back until you hear a two-tone beep, then tell me when it beeps." },
        { who: "patient", at: "1:02", text: "Done, it beeped. The blue light is solid now." },
        { kind: "tool", at: "1:10", tool: "device.recheck_connection", args: ["device: RM-200 · S/N 61-774-33", "retry: 1"], result: "Transmitting · last transmission 1m ago · signal strong", ms: "720ms" },
        { who: "agent", at: "1:18", text: "You are transmitting again. Thank you for your time, we will confirm receipt on our side. Have a good rest of your day." }
      ],
      trip: null,
      completion: {
        title: "No guardrail trip · run completed",
        status: ["Transmitting", "green"]
      }
    }
  };

  var WORKLIST_NEXT = {
    urgent: {
      "nurse-callback": [
        { prio: "urgent", title: "Nurse callback to M. Rivera", sub: "{clinician} · symptom reported · 15 min SLA", status: "QUEUED" },
        { prio: "routine", title: "Confirm monitor reconnection SMS sent", sub: "Outreach from branded line", status: "QUEUED" }
      ],
      "follow-up": [
        { prio: "urgent", title: "Nurse callback to M. Rivera", sub: "{clinician} · symptom reported · 15 min SLA", status: "QUEUED" },
        { prio: "routine", title: "Schedule follow-up within 24h", sub: "Monitor reconnection check", status: "QUEUED" }
      ],
      "window-review": [
        { prio: "urgent", title: "Nurse callback to M. Rivera", sub: "{clinician} · symptom reported · 15 min SLA", status: "QUEUED" },
        { prio: "routine", title: "Request transmission window review", sub: "Device team · RM-200 S/N 84-221-09", status: "QUEUED" }
      ]
    },
    routine: [
      { prio: "auto", title: "Mark transmission received · RM-200", sub: "Auto-close case · no clinical action needed", status: "QUEUED" }
    ]
  };

  /* ---------------- state ---------------- */

  var state = {
    scenario: "urgent",
    idx: 0,               /* index of the next turn to reveal */
    playing: false,
    phase: "idle",        /* idle | tripped | handed_off | done */
    timer: null
  };

  var $ = function (sel) { return document.querySelector(sel); };
  var $$ = function (sel) { return Array.from(document.querySelectorAll(sel)); };

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function scn() { return SCENARIOS[state.scenario]; }

  /* ---------------- rendering ---------------- */

  function statusStyle(kind) {
    var map = { Disconnected: "amber", "Escalated to human": "red", Transmitting: "green" };
    return map[kind] || "amber";
  }

  function setPill(el, label, tone) {
    el.innerHTML = '<span class="dot dot-' + tone + '"></span>' + esc(label);
    el.className = "status-pill " + tone;
  }

  function renderEvent() {
    var e = scn().event;
    $("#ev-trigger").textContent = e.trigger;
    $("#ev-patient").textContent = e.patient;
    $("#ev-device").textContent = e.device;
    $("#ev-loss").textContent = e.loss;
    $("#ev-line").textContent = e.line;
    setPill($("#ev-status"), e.status[0], e.status[1]);
    $("#run-title").textContent = "Voice run · " + e.trigger.toLowerCase();
  }

  function revealTurn(i) {
    var turn = scn().turns[i];
    var list = $("#transcript");
    var li = document.createElement("li");
    li.className = "tturn";

    if (turn.kind === "tool") {
      li.innerHTML = '<div class="turn-meta"><span class="who agent">Tool</span><span>' + esc(turn.at) + "</span></div>" +
        '<div class="bubble agent tool-bubble">' + esc(turn.tool) + "</div>";
      list.appendChild(li);
      appendToolCtx(i, turn);
      return;
    }

    if (turn.held) {
      li.className = "tturn blocked-hold";
      li.innerHTML = "<b>Agent turn held by guardrail</b> &#8212; " + esc(turn.text) + ' <span class="gt-q">turn not spoken</span>';
      list.appendChild(li);
      appendBlocked(turn);
      return;
    }

    var text = esc(turn.text);
    if (turn.cite) {
      var c = esc(turn.cite);
      var safe = c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      text = text.replace(new RegExp(safe, "i"), '<span class="cited">$&</span>');
    }
    li.innerHTML = '<div class="turn-meta"><span class="who ' + turn.who + '">' +
      (turn.who === "agent" ? "Voice agent" : "Patient") + "</span><span>" + esc(turn.at) + "</span>" +
      (turn.trip ? ' <span class="live-chip">GUARDRAIL TRIP</span>' : "") + "</div>" +
      '<div class="bubble ' + turn.who + '">' + text + "</div>";
    list.appendChild(li);
  }

  function appendToolCtx(i, turn) {
    var ul = $("#action-list");
    var li = document.createElement("li");
    li.id = "tool-" + i;
    li.innerHTML = '<div class="tool-head">' +
      '<span class="tool-tick run">&hellip;</span>' +
      '<span class="tool-name">' + esc(turn.tool) + "</span>" +
      '<span class="tool-band">tool call</span>' +
      '<span class="tool-latency">' + esc(turn.ms) + "</span></div>" +
      '<div class="tool-args">' + turn.args.map(function (a) { return '<span class="tool-arg">' + esc(a) + "</span>"; }).join("") + "</div>" +
      '<div class="tool-result">' + esc(turn.result) + "</div>";
    ul.appendChild(li);
    window.setTimeout(function () {
      var card = $("#tool-" + i);
      if (card) {
        var runTick = card.querySelector(".tool-tick.run");
        if (runTick) runTick.outerHTML = '<span class="tool-tick ok">&#10003;</span>';
      }
    }, 500);
    updateActionCount();
  }

  function appendBlocked(turn) {
    var ul = $("#action-list");
    var li = document.createElement("li");
    li.className = "action-blocked";
    li.innerHTML = '<div class="ab-head">Turn held by guardrail</div>' +
      '<div class="ab-sub">No further agent turns until a clinician override is recorded.</div>' +
      "<code>" + esc(turn.text) + "</code>";
    ul.appendChild(li);
    updateActionCount();
  }

  function updateActionCount() {
    $("#action-count").textContent = "· " + $$("#action-list li").length + " logged";
  }

  /* ---------------- harness ---------------- */

  function idleHarness(completed) {
    var h = $("#harness");
    h.innerHTML = "";
    var wrap = document.createElement("div");
    if (completed) {
      wrap.className = "harness-idle";
      wrap.style.borderStyle = "solid";
      wrap.style.borderColor = "#abd7b7";
      wrap.style.background = "#e8f4eb";
      wrap.innerHTML = '<p class="idle-text" style="color:#1e7d4f"><b>No guardrail trip · run completed.</b> Routine fix stayed contained: the harness monitored every turn and nothing urgent or uncertain was said.</p>' +
        '<div class="chips"><span class="chip" title="No PHI left the platform; urgent turns are never auto-resumed">Containment 100%</span>' +
        '<span class="chip" title="p95 time from patient turn end to next agent turn">Latency p95 1.0s</span></div>';
    } else {
      wrap.className = "harness-idle";
      wrap.innerHTML = '<p class="idle-text">Monitoring call for urgent or uncertain clinical content. No trip so far.</p>' +
        '<div class="chips"><span class="chip" title="No PHI left the platform; urgent turns are never auto-resumed">Containment 100%</span>' +
        '<span class="chip" title="p95 time from patient turn end to next agent turn">Latency p95 1.2s</span></div>';
    }
    h.appendChild(wrap);
  }

  function tripHarness() {
    var t = scn().trip;
    var h = $("#harness");
    h.innerHTML = "";
    var wrap = document.createElement("div");
    wrap.className = "guardrail-trip";
    wrap.innerHTML =
      '<div class="gt-banner">&#9888; Guardrail tripped</div>' +
      '<p class="gt-rule">Rule <code>' + esc(t.rule) + "</code> · severity <b>" + esc(t.severity) + "</b></p>" +
      '<p class="gt-why">' + esc(t.why) + "</p>" +
      '<div class="gt-span"><span class="gt-q">cited transcript span</span><br>' + esc(t.spanText) + "</div>" +
      '<div class="chips"><span class="chip" title="No PHI left the platform; urgent turns are never auto-resumed">Containment 100%</span>' +
      '<span class="chip" title="p95 time from patient turn end to next agent turn">Latency p95 1.2s</span></div>' +
      '<div class="harness-blocked"><div class="hb-title">Agent paused · cannot continue alone</div>' +
      '<div class="hb-sub">' + esc(t.hold) + "</div>" +
      '<div class="hb-gate">contract: escalate_to_human == required</div></div>' +
      '<button type="button" class="cta" id="btn-escalate">Escalate to human</button>' +
      '<button type="button" class="solo-blocked" title="Guardrail held the run: escalating to human is mandatory before any further agent turn." disabled>Continue agent without escalation <small>blocked by guardrail · mandatory escalate-to-human path</small></button>';
    h.appendChild(wrap);
    $("#btn-escalate").addEventListener("click", showOverride);
  }

  function showOverride() {
    $("#override-panel").hidden = false;
    $("#btn-escalate").disabled = true;
    $("#btn-escalate").textContent = "Escalation in progress";
  }

  function handleOverride(ev) {
    ev.preventDefault();
    var form = $("#override-form");
    var clinician = (form.querySelector("#ov-clinician").value || "clinical staff").trim();
    var disp = form.querySelector('input[name="disposition"]:checked');
    if (!disp) return;
    var disposition = disp.value;

    $("#override-panel").hidden = true;
    $("#handoff-done").hidden = false;
    $("#handoff-done .handoff-sub").textContent = clinician + " · " + disposition.replace(/-/g, " ");

    state.phase = "handed_off";
    $("#btn-step").disabled = true;
    $("#btn-play").disabled = true;
    $("#btn-play").textContent = "Done";
    $("#live-chip").className = "live-chip off";
    $("#live-chip").textContent = "HANDED OFF";

    var comp = scn().completion;
    setPill($("#ev-status"), comp.status[0], statusStyle(comp.status[0]));

    queueWorklist(WORKLIST_NEXT.urgent[disposition].map(function (row) {
      return { prio: row.prio, title: row.title, sub: row.sub.replace("{clinician}", clinician), status: row.status };
    }));
    var escBtn = $("#btn-escalate");
    if (escBtn) escBtn.style.display = "none";
  }

  function queueWorklist(rows) {
    var wl = $("#worklist");
    wl.innerHTML = "";
    rows.forEach(function (row) {
      var d = document.createElement("div");
      d.className = "wl-row";
      d.innerHTML = '<span class="wl-priority ' + row.prio + '">' + esc(row.prio) + "</span>" +
        '<div class="wl-text"><b>' + esc(row.title) + "</b><small>" + esc(row.sub) + "</small></div>" +
        '<span class="wl-status">' + esc(row.status) + "</span>";
      wl.appendChild(d);
    });
  }

  /* ---------------- playback ---------------- */

  function pacing(turn) {
    var base = turn.kind === "tool" ? 1300 : 900;
    var extra = Math.min(1400, (turn.text || "").length * 16);
    return base + extra;
  }

  function nextTurnReady() {
    return state.idx < scn().turns.length;
  }

  function advance() {
    if (!nextTurnReady()) { finishRun(); return; }
    if (state.phase === "tripped" || state.phase === "handed_off" || state.phase === "done") return;

    var turn = scn().turns[state.idx];
    revealTurn(state.idx);
    state.idx += 1;

    if (turn.trip) {
      state.phase = "tripped";
      state.playing = false;
      clearTimeout(state.timer);
      $("#btn-play").disabled = true;
      $("#btn-play").textContent = "Paused";
      $("#btn-step").disabled = true;
      if (state.idx < scn().turns.length) {
        revealTurn(state.idx);   /* the held agent turn, shown as blocked */
        state.idx += 1;
      }
      tripHarness();
      $("#live-chip").className = "live-chip off";
      $("#live-chip").textContent = "HELD";
      return;
    }
    tick();
  }

  function tick() {
    if (!state.playing) return;
    if (!nextTurnReady()) { finishRun(); return; }
    var turn = scn().turns[state.idx];
    state.timer = setTimeout(advance, pacing(turn));
  }

  function finishRun() {
    state.phase = "done";
    state.playing = false;
    $("#btn-play").disabled = true;
    $("#btn-play").textContent = "Done";
    $("#btn-step").disabled = true;
    $("#live-chip").className = "live-chip off";
    if (state.scenario === "routine") {
      idleHarness(true);
      setPill($("#ev-status"), "Transmitting", "green");
      queueWorklist(WORKLIST_NEXT.routine);
      $("#live-chip").textContent = "COMPLETE";
    } else {
      $("#live-chip").textContent = "ENDED";
    }
  }

  function play() {
    if (state.phase === "tripped" || state.phase === "handed_off" || state.phase === "done") return;
    state.playing = !state.playing;
    $("#btn-play").textContent = state.playing ? "Pause" : "Play";
    if (state.playing) tick();
    else clearTimeout(state.timer);
  }

  function step() {
    if (state.phase === "tripped" || state.phase === "handed_off" || state.phase === "done") return;
    state.playing = false;
    $("#btn-play").textContent = "Play";
    clearTimeout(state.timer);
    advance();
  }

  function reset(scenarioId) {
    clearTimeout(state.timer);
    if (scenarioId) state.scenario = scenarioId;
    state.idx = 0;
    state.playing = false;
    state.phase = "idle";

    $("#transcript").innerHTML = "";
    $("#action-list").innerHTML = "";
    $("#action-count").textContent = "";
    $("#worklist").innerHTML = '<p class="worklist-empty">No next actions queued yet.</p>';
    $("#override-panel").hidden = true;
    $("#handoff-done").hidden = true;
    $("#btn-play").disabled = false;
    $("#btn-play").textContent = "Play";
    $("#btn-step").disabled = false;
    var escBtn = $("#btn-escalate");
    if (escBtn) escBtn.style.display = "";
    var form = $("#override-form");
    if (form) form.reset();

    $$(".scenario-btn").forEach(function (b) {
      b.className = b.dataset.scn === state.scenario ? "scenario-btn active" : "scenario-btn";
    });

    renderEvent();
    idleHarness(false);
    $("#live-chip").className = "live-chip";
    $("#live-chip").textContent = "LIVE";

    state.playing = true;
    $("#btn-play").textContent = "Pause";
    tick();
  }

  /* ---------------- wiring ---------------- */

  $("#btn-play").addEventListener("click", play);
  $("#btn-step").addEventListener("click", step);
  $("#btn-restart").addEventListener("click", function () { reset(); });
  $$(".scenario-btn").forEach(function (b) {
    b.addEventListener("click", function () { reset(b.dataset.scn); });
  });
  $("#override-form").addEventListener("submit", handleOverride);

  reset("urgent");
})();