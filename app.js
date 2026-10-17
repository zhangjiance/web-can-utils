import { XCanConfig, XCanMessage, xcanRegistry } from "./can_hal.js";
import "./gs_usb.js";

(() => {
  "use strict";

  /*
   * Timing presets, as (arbitration bitrate, data bitrate).  The order matters:
   * the first entry is the default for a fresh channel, and the first three are
   * what the tests and the docs use, so new pairs are appended.
   *
   * The list is the usual CAN FD spread (CiA 601 style): 125k/250k/500k/1M
   * arbitration paired with 1M/2M/4M/5M/8M data.  Classic rates come for free -
   * with Force CAN2.0 ticked only the nominal phase is programmed - as does any
   * rate reachable through the per-phase ⚙ dialog, which takes explicit values.
   *
   * Every pair here solves on the 80 MHz CAN clock within the ranges the device
   * reports (brp 1..512 / seg1 1..256 / seg2 1..128 nominal, brp 1..32 /
   * seg1 1..32 / seg2 1..16 data) at a sample point of 80 % (81.25 % for the
   * 5 Mbit/s pairs - 16 time quanta per bit is as close as it gets).
   */
  const PRESET_TO_BITRATE = {
    "500k_2m": { nominal: 500000, data: 2000000 },
    "500k_4m": { nominal: 500000, data: 4000000 },
    "1m_4m": { nominal: 1000000, data: 4000000 },
    "125k_1m": { nominal: 125000, data: 1000000 },
    "250k_1m": { nominal: 250000, data: 1000000 },
    "250k_2m": { nominal: 250000, data: 2000000 },
    "500k_1m": { nominal: 500000, data: 1000000 },
    "500k_5m": { nominal: 500000, data: 5000000 },
    "1m_2m": { nominal: 1000000, data: 2000000 },
    "1m_5m": { nominal: 1000000, data: 5000000 },
    "1m_8m": { nominal: 1000000, data: 8000000 }
  };

  const RX_RENDER_THROTTLE_MS = 80;
  const TX_RENDER_THROTTLE_MS = 80;
  /* Upper bound for deferring TX-table repaints while a pointer is held. */
  const TX_POINTER_HELD_MAX_MS = 2000;

  const ui = {
    themeLight: document.getElementById("themeLight"),
    themeDark: document.getElementById("themeDark"),

    protocolSelect: document.getElementById("protocolSelect"),
    btnDevice: document.getElementById("btnDevice"),
    btnStartStop: document.getElementById("btnStartStop"),
    btnReset: document.getElementById("btnReset"),
    btnOpenTxModal: document.getElementById("btnOpenTxModal"),
    btnClearRx: document.getElementById("btnClearRx"),

    chipState: document.getElementById("chipState"),
    chipVidPid: document.getElementById("chipVidPid"),
    chipIf: document.getElementById("chipIf"),
    chipEp: document.getElementById("chipEp"),
    chipFwVer: document.getElementById("chipFwVer"),
    chipHw: document.getElementById("chipHw"),

    modalBackdrop: document.getElementById("modalBackdrop"),
    connectModal: document.getElementById("connectModal"),
    deviceInfoPlaceholder: document.getElementById("deviceInfoPlaceholder"),
    txModal: document.getElementById("txModal"),
    txDataModal: document.getElementById("txDataModal"),

    btnCloseConnectModal: document.getElementById("btnCloseConnectModal"),
    btnStartBus: document.getElementById("btnStartBus"),
    btnDisconnectDevice: document.getElementById("btnDisconnectDevice"),

    thTerm: document.getElementById("thTerm"),
    channelRows: document.getElementById("channelRows"),
    clockInfo: document.getElementById("clockInfo"),
    btnApplyAllTiming: document.getElementById("btnApplyAllTiming"),
    txChannel: document.getElementById("txChannel"),
    preset: document.getElementById("preset"),
    listenOnly: document.getElementById("listenOnly"),
    forceClassic: document.getElementById("forceClassic"),

    timingModal: document.getElementById("timingModal"),
    btnCloseTimingModal: document.getElementById("btnCloseTimingModal"),
    timingTitle: document.getElementById("timingTitle"),
    timingClock: document.getElementById("timingClock"),
    nominalPhase: document.getElementById("nominalPhase"),
    nomResult: document.getElementById("nomResult"),
    dataPhase: document.getElementById("dataPhase"),
    dataResult: document.getElementById("dataResult"),
    btnTimingCancel: document.getElementById("btnTimingCancel"),
    btnApplyPending: document.getElementById("btnApplyPending"),
    nomBitrate: document.getElementById("nomBitrate"),
    nomSample: document.getElementById("nomSample"),
    nomTable: document.getElementById("nomTable"),
    nomChosen: document.getElementById("nomChosen"),
    dataBitrate: document.getElementById("dataBitrate"),
    dataSample: document.getElementById("dataSample"),
    dataTable: document.getElementById("dataTable"),
    dataChosen: document.getElementById("dataChosen"),
    btnTimingOk: document.getElementById("btnTimingOk"),

    rxSummaryBody: document.getElementById("rxSummaryBody"),
    txTaskBody: document.getElementById("txTaskBody"),
    btnDebug: document.getElementById("btnDebug"),
    debugPane: document.getElementById("debugPane"),
    debugLog: document.getElementById("debugLog"),
    debugCount: document.getElementById("debugCount"),
    debugFrames: document.getElementById("debugFrames"),
    btnDebugClear: document.getElementById("btnDebugClear"),

    txModalTitle: document.getElementById("txModalTitle"),
    btnCloseTxModal: document.getElementById("btnCloseTxModal"),
    btnTxAdd: document.getElementById("btnTxAdd"),
    btnTxDone: document.getElementById("btnTxDone"),
    btnTxCancel: document.getElementById("btnTxCancel"),

    txId: document.getElementById("txId"),
    txLen: document.getElementById("txLen"),
    txByteBoxes: document.getElementById("txByteBoxes"),
    txDataBoxes: document.getElementById("txDataBoxes"),
    txDataLen: document.getElementById("txDataLen"),
    btnMoreData: document.getElementById("btnMoreData"),
    btnCloseDataModal: document.getElementById("btnCloseDataModal"),
    btnApplyDataModal: document.getElementById("btnApplyDataModal"),
    btnCancelDataModal: document.getElementById("btnCancelDataModal"),
    txExt: document.getElementById("txExt"),
    txFd: document.getElementById("txFd"),
    txRtr: document.getElementById("txRtr"),
    txBrs: document.getElementById("txBrs"),
    txPeriod: document.getElementById("txPeriod"),
    txComment: document.getElementById("txComment")
  };

  const state = {
    adapter: null,
    connected: false,
    busReady: false,
    /* Channels the host started (kept in sync with adapter.startedChannels). */
    startedChannels: [],
    /* Bus settings of the last successful start, so RST can re-initialise the
     * same way without going through the configuration modal. */
    lastBusConfig: null,
    /* Per-channel panel state: which channels Start ticked, and (gs_usb with a
     * terminator) which ones have the 120 ohm terminator switched on. */
    channelSettings: {},
    /* Per-channel timing: preset key, or custom register values for the nominal
     * and FD data phase, plus the bitrate/sample-point query behind the table. */
    channelTiming: {},
    timingChannel: 0,
    /* which phase the timing sub-panel edits ("nominal" | "data") */
    timingPhase: "nominal",
    timingDraft: null,
    /* What each started channel is programmed with right now, to spot pending
     * changes (configKeyFor()). */
    runningConfig: {},
    rxSummaryMap: new Map(),
    rxRows: new Map(),
    /* byte-box containers, for re-layout on window resize */
    byteBoxLayouts: new Map(),
    rxRenderTimer: null,
    txTasks: [],
    txRenderTimer: null,
    txTaskSeq: 1,
    txEditingTaskId: null,
    txExtraData: [],
    /* DEBUG column: device commands always collected (a small ring buffer),
     * normal frames only when asked for (see debugFrames) */
    debugOn: false,
    debugFrames: false,
    debugLog: [],
    debugSeq: 0,
    /* stable TX row nodes (task id -> node), so inline editors survive the
     * constant repaints the frame counter causes */
    txRows: new Map(),
    /* selected TX row (kept by task id so repaints cannot lose it) */
    txSelectedId: null,
    txClipboard: null,
    /* true while the form still holds exactly what Add already saved, so Done
     * closes instead of adding the cleared form a second time */
    txFormAlreadyAdded: false
  };

  /* memoised flash colours, dropped whenever the theme changes */
  let flashStyleCached = null;

  function setTheme(theme) {
    const t = theme === "light" ? "light" : "dark";
    flashStyleCached = null;             /* the flash colour follows the theme */
    document.body.setAttribute("data-theme", t);
    localStorage.setItem("web-can-utils-theme", t);
    ui.themeLight.classList.toggle("active", t === "light");
    ui.themeDark.classList.toggle("active", t === "dark");
  }

  function initTheme() {
    const saved = localStorage.getItem("web-can-utils-theme") || "dark";
    setTheme(saved);
    ui.themeLight.addEventListener("click", () => setTheme("light"));
    ui.themeDark.addEventListener("click", () => setTheme("dark"));
  }

  function setStateText(text, cls) {
    ui.chipState.textContent = text;
    ui.chipState.className = `mono ${cls || ""}`;
    /* long transport errors are ellipsised in the chip: keep them readable */
    ui.chipState.title = `${text} (click for bus configuration)`;
  }

  function syncConnectButton() {
    if (!ui.btnDevice) return;
    if (state.connected) {
      ui.btnDevice.textContent = "⚙ Device";
      ui.btnDevice.title = "Device / bus configuration";
    } else {
      ui.btnDevice.textContent = "🔌 Device";
      ui.btnDevice.title = "Add a device";
    }
  }

  function resetDeviceChips() {
    ui.chipVidPid.textContent = "-";
    ui.chipIf.textContent = "-";
    ui.chipEp.textContent = "-";
    ui.chipFwVer.textContent = "-";
    ui.chipHw.textContent = "-";
  }

  function updateDeviceChips() {
    if (!state.adapter || !state.adapter.device) {
      resetDeviceChips();
      return;
    }
    const dev = state.adapter.device;
    ui.chipVidPid.textContent = `0x${dev.vendorId.toString(16).padStart(4, "0")}:0x${dev.productId.toString(16).padStart(4, "0")}`;

    const map = state.adapter.channelMap;
    if (map && map.length) {
      /* gs_usb: one interface carrying `icount + 1` channels. */
      const started = state.startedChannels.length;
      ui.chipIf.textContent = `${map[0].interfaceNumber} (${map.length} ch${started ? `, ${started} up` : ""})`;
      ui.chipEp.textContent = `M ${map[0].outEp.toString(16)}/${map[0].inEp.toString(16)}`;
    } else {
      ui.chipIf.textContent = String(state.adapter.interfaceNumber || 0);
      ui.chipEp.textContent = `C ${state.adapter.cmdOutEp.toString(16)}/${state.adapter.cmdInEp.toString(16)} M ${state.adapter.msgOutEp.toString(16)}/${state.adapter.msgInEp.toString(16)}`;
    }

    ui.chipFwVer.textContent = state.adapter.deviceInfo?.firmware || "-";
    ui.chipHw.textContent = state.adapter.deviceInfo?.hardware || "-";
  }

  function loadProtocols() {
    ui.protocolSelect.disabled = true;
    ui.protocolSelect.innerHTML = "";

    const loadingOp = document.createElement("option");
    loadingOp.value = "";
    loadingOp.textContent = "Loading protocols...";
    loadingOp.disabled = true;
    loadingOp.selected = true;
    ui.protocolSelect.appendChild(loadingOp);

    const list = (typeof xcanRegistry !== "undefined" && xcanRegistry && typeof xcanRegistry.list === "function")
      ? xcanRegistry.list()
      : [];

    ui.protocolSelect.innerHTML = "";
    if (!list.length) {
      const emptyOp = document.createElement("option");
      emptyOp.value = "";
      emptyOp.textContent = "No protocol found";
      emptyOp.disabled = true;
      emptyOp.selected = true;
      ui.protocolSelect.appendChild(emptyOp);
      return false;
    }

    for (const p of list) {
      const op = document.createElement("option");
      op.value = p.name;
      op.textContent = p.displayName || p.name;
      ui.protocolSelect.appendChild(op);
    }
    const hasGsusb = list.some((p) => p.name === "gsusb");
    ui.protocolSelect.value = hasGsusb ? "gsusb" : list[0].name;
    console.log("[web-can-utils] loaded protocols:", list.map((p) => p.name).join(", "));
    ui.protocolSelect.disabled = false;
    return true;
  }

  function parseHexBytes(text) {
    const clean = (text || "").trim();
    if (!clean) return [];
    return clean.split(/[\s,]+/).map((s) => {
      const v = parseInt(s, 16);
      if (!Number.isFinite(v) || v < 0 || v > 255) {
        throw new Error(`Invalid byte: ${s}`);
      }
      return v;
    });
  }

  function bytesToHexText(bytes) {
    return bytes.map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");
  }

  function formatCycleAuto(us) {
    if (!Number.isFinite(us)) return "-";
    if (us < 1000) return `${Math.round(us)} us`;
    const ms = us / 1000;
    if (ms < 1000) return `${ms.toFixed(ms < 10 ? 2 : ms < 100 ? 1 : 0)} ms`;
    const s = ms / 1000;
    return `${s.toFixed(s < 10 ? 2 : s < 100 ? 1 : 0)} s`;
  }

  function showModal(which) {
    ui.modalBackdrop.classList.add("show");
    ui.connectModal.classList.toggle("show", which === "connect");
    ui.txModal.classList.toggle("show", which === "tx");
    ui.txDataModal.classList.toggle("show", which === "txdata");
    ui.timingModal.classList.toggle("show", which === "timing");
  }

  function hideModals() {
    ui.modalBackdrop.classList.remove("show");
    ui.connectModal.classList.remove("show");
    ui.txModal.classList.remove("show");
    ui.txDataModal.classList.remove("show");
    ui.timingModal.classList.remove("show");
  }

  /* CAN FD DLC table: valid data lengths */
  const FD_VALID_LENS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64];

  function fillTxLenOptions(fd) {
    ui.txLen.innerHTML = "";
    const max = fd ? 64 : 8;
    const vals = fd ? FD_VALID_LENS : [0, 1, 2, 3, 4, 5, 6, 7, 8];
    for (const v of vals) {
      const op = document.createElement("option");
      op.value = String(v);
      op.textContent = String(v);
      if (v === 8) op.selected = true;
      ui.txLen.appendChild(op);
    }
  }

  function collectMsgFlags() {
    return {
      extended: !!ui.txExt.checked,
      fd: !!ui.txFd.checked,
      rtr: !!ui.txRtr.checked,
      brs: !!ui.txBrs.checked,
      esi: false  /* RX only */
    };
  }

  function setMsgFlagsUI(flags) {
    ui.txExt.checked = !!flags.extended;
    ui.txFd.checked = !!flags.fd;
    ui.txRtr.checked = !!flags.rtr;
    ui.txBrs.checked = !!flags.brs;
  }

  function flagsToTypeLabel(flags) {
    const parts = [];
    if (flags.fd) { parts.push("FD"); }
    else { parts.push("CAN"); }
    if (flags.brs) parts.push("BRS");
    if (flags.rtr) parts.push("RTR");
    parts.push(flags.extended ? "EXT" : "STD");
    return parts.join(" ");
  }

  /* ---- per-byte data entry ------------------------------------------ */

  const TX_BYTE_BOXES = 8;

  function byteBoxEl(prefix, i) {
    return window.document.getElementById(`${prefix}-${i}`);
  }

  function focusByteBox(prefix, i, count) {
    if (i < 0 || i >= count) {
      return;
    }
    const box = byteBoxEl(prefix, i);
    if (box) {
      box.focus();
      box.select();
    }
  }

  /*
   * Indexed one-input-per-byte editor, used both by the message form (8 bytes)
   * and by the full-data editor (up to 64).  Typing two hex digits moves to the
   * next byte, arrows/backspace move around, pasting fills the following boxes.
   */
  /* Assumed box width when the browser cannot measure yet (hidden container). */
  const BYTE_BOX_WIDTH_PX = 32;
  const BYTE_BOX_GAP_PX = 3;

  /*
   * Even rows: the smallest number of rows that still fits, with the bytes
   * spread evenly over them - 12 bytes and room for 5 must give 4/4/4, not the
   * greedy 5/5/2 that leaves the last row short.
   */
  function layoutByteBoxes(container, count) {
    if (!container || count <= 0) {
      return;
    }

    const first = container.children[0];
    const boxWidth = (first && first.offsetWidth) || BYTE_BOX_WIDTH_PX;
    const available = container.clientWidth || (container.parentElement && container.parentElement.clientWidth) || 0;

    let perRow = count;
    if (available > 0) {
      perRow = Math.max(1, Math.floor((available + BYTE_BOX_GAP_PX) / (boxWidth + BYTE_BOX_GAP_PX)));
      perRow = Math.ceil(count / Math.ceil(count / perRow));
    }

    container.style.display = "grid";
    container.style.gridTemplateColumns = `repeat(${perRow}, auto)`;
    container.style.gap = `${BYTE_BOX_GAP_PX}px`;
    container.style.justifyContent = "start";
    container.dataset.perRow = String(perRow);
  }

  function relayoutByteBoxes() {
    for (const [container, count] of state.byteBoxLayouts) {
      layoutByteBoxes(container, count);
    }
  }

  function buildByteBoxes(container, count, prefix) {
    container.innerHTML = "";
    state.byteBoxLayouts.set(container, count);

    for (let i = 0; i < count; i++) {
      const cell = window.document.createElement("span");
      cell.style.cssText = "display:flex;flex-direction:column;align-items:center;gap:1px";

      const index = window.document.createElement("small");
      index.textContent = String(i);
      index.style.cssText = "font-size:.55rem;color:var(--ink-soft);line-height:1";

      const input = window.document.createElement("input");
      input.id = `${prefix}-${i}`;
      input.maxLength = 2;
      input.autocomplete = "off";
      input.style.cssText = "width:2.6em;padding:3px 2px;font-size:.75rem;text-align:center";

      input.addEventListener("focus", () => input.select());
      input.addEventListener("input", () => {
        input.value = input.value.replace(/[^0-9a-fA-F]/g, "").slice(0, 2).toUpperCase();
        if (input.value.length === 2) {
          focusByteBox(prefix, i + 1, count);
        }
      });
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Backspace" && input.value === "") {
          focusByteBox(prefix, i - 1, count);
          ev.preventDefault();
        } else if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") {
          focusByteBox(prefix, i + (ev.key === "ArrowRight" ? 1 : -1), count);
          ev.preventDefault();
        } else if (ev.key === " ") {
          focusByteBox(prefix, i + 1, count);
          ev.preventDefault();
        }
      });
      input.addEventListener("paste", (ev) => {
        const text = (ev.clipboardData && ev.clipboardData.getData("text")) || "";
        const bytes = (text.match(/[0-9a-fA-F]{2}/g) || []).map((h) => parseInt(h, 16));
        if (bytes.length === 0) {
          return;
        }
        ev.preventDefault();
        bytes.slice(0, count - i).forEach((b, k) => {
          const box = byteBoxEl(prefix, i + k);
          if (box) {
            box.value = b.toString(16).padStart(2, "0").toUpperCase();
          }
        });
        focusByteBox(prefix, i + bytes.length, count);
      });

      cell.appendChild(index);
      cell.appendChild(input);
      container.appendChild(cell);
    }

    layoutByteBoxes(container, count);
  }

  function readByteBoxes(prefix, count) {
    const out = [];
    for (let i = 0; i < count; i++) {
      const value = (byteBoxEl(prefix, i)?.value || "").trim();
      out.push(value ? (parseInt(value, 16) & 0xff) : 0);
    }
    return out;
  }

  function writeByteBoxes(prefix, count, bytes) {
    for (let i = 0; i < count; i++) {
      const box = byteBoxEl(prefix, i);
      if (box) {
        box.value = i < bytes.length
          ? (bytes[i] & 0xff).toString(16).padStart(2, "0").toUpperCase()
          : "";
      }
    }
  }

  function buildTxByteBoxes() {
    buildByteBoxes(ui.txByteBoxes, TX_BYTE_BOXES, "data-byte");
    updateTxByteBoxDims();
  }

  function byteBox(i) {
    return byteBoxEl("data-byte", i);
  }

  function readTxDataUi() {
    return readByteBoxes("data-byte", TX_BYTE_BOXES);
  }

  /* bytes = every byte of the message; bytes beyond 8 live in txExtraData */
  function writeTxDataUi(bytes, len) {
    for (let i = 0; i < TX_BYTE_BOXES; i++) {
      const box = byteBox(i);
      if (box) {
        box.value = i < bytes.length
          ? (bytes[i] & 0xff).toString(16).padStart(2, "0").toUpperCase()
          : "";
      }
    }
    state.txExtraData = bytes.slice(TX_BYTE_BOXES);
    if (typeof len === "number") {
      ui.txLen.value = String(len);
    }
    updateTxByteBoxDims();
  }

  /* bytes outside the current length stay visible but dimmed */
  function updateTxByteBoxDims() {
    const len = Math.max(0, Math.min(64, Number(ui.txLen.value) || 0));
    for (let i = 0; i < TX_BYTE_BOXES; i++) {
      const box = byteBox(i);
      if (box && box.parentElement) {
        box.parentElement.style.opacity = i < len ? "" : "0.35";
      }
    }
  }

  function getTxDataBytesFromUi() {
    const len = Math.max(0, Math.min(64, Number(ui.txLen.value) || 0));
    const head = readTxDataUi();
    const out = new Array(len).fill(0);
    for (let i = 0; i < Math.min(TX_BYTE_BOXES, len); i++) {
      out[i] = head[i];
    }
    for (let i = TX_BYTE_BOXES; i < len; i++) {
      out[i] = state.txExtraData[i - TX_BYTE_BOXES] || 0;
    }
    return out;
  }

  function fullDataLen() {
    return Math.max(0, Math.min(64, Number(ui.txDataLen.value) || 0));
  }

  /* The full editor always offers every CAN FD length; picking more than 8 for
   * a classic frame switches it to FD on Apply. */
  function fillDataLenOptions() {
    const prev = ui.txDataLen.value;
    ui.txDataLen.innerHTML = "";
    for (const v of FD_VALID_LENS) {
      const op = document.createElement("option");
      op.value = String(v);
      op.textContent = String(v);
      ui.txDataLen.appendChild(op);
    }
    if (Array.from(ui.txDataLen.options).some((o) => o.value === prev)) {
      ui.txDataLen.value = prev;
    } else {
      ui.txDataLen.value = "8";
    }
  }

  function rebuildFullDataBoxes(bytes) {
    const len = fullDataLen();
    buildByteBoxes(ui.txDataBoxes, len, "full-byte");
    writeByteBoxes("full-byte", len, bytes || []);
  }

  function openDataModal() {
    const len = Math.max(Number(ui.txLen.value) || 0, 8);
    if (len > 8 && !ui.txFd.checked) {
      ui.txFd.checked = true;                 /* >8 bytes can only be CAN FD */
      fillTxLenOptions(true);
      updateTxModalDeps();
    }
    fillDataLenOptions();
    ui.txDataLen.value = String(len);
    showModal("txdata");           /* visible first: the layout is measurable then */
    rebuildFullDataBoxes(getTxDataBytesFromUi());
    relayoutByteBoxes();
  }

  function applyDataModal() {
    const bytes = readByteBoxes("full-byte", fullDataLen()).slice(0, 64);

    /* more than 8 bytes can only be a CAN FD frame: switch the mode for the
     * user instead of silently losing the length */
    if (bytes.length > 8 && !ui.txFd.checked) {
      ui.txFd.checked = true;
      fillTxLenOptions(true);
      updateTxModalDeps();
    }
    ui.txLen.value = String(bytes.length);
    writeTxDataUi(bytes, bytes.length);
    state.txFormAlreadyAdded = false;
    showModal("tx");
  }

  function openTxModalForNew({ alreadyAdded = false } = {}) {
    state.txEditingTaskId = null;
    state.txFormAlreadyAdded = alreadyAdded;
    ui.txModalTitle.textContent = "Add TX Frame";
    ui.txId.value = "0";
    ui.txLen.value = "8";
    writeTxDataUi(new Array(TX_BYTE_BOXES).fill(0x55), TX_BYTE_BOXES);
    ui.txPeriod.value = "100";          /* a new message defaults to a 100 ms cycle */
    setMsgFlagsUI({ fd: false, extended: false, rtr: false, brs: false });
    ui.txComment.value = "";
    state.txFormAlreadyAdded = alreadyAdded;
    populateTxChannelSelect(state.startedChannels);
    showModal("tx");
    relayoutByteBoxes();
    updateTxModalDeps();
  }

  function openTxModalForEdit(task) {
    state.txEditingTaskId = task.id;
    state.txFormAlreadyAdded = false;
    ui.txModalTitle.textContent = "Edit TX Frame";

    /* Set flags first so fillTxLenOptions uses correct FD mode */
    setMsgFlagsUI({
      extended: task.message.extended,
      fd: task.message.fd,
      rtr: task.message.rtr,
      brs: task.message.brs
    });
    /* Then populate length dropdown with correct FD/classic options */
    fillTxLenOptions(!!task.message.fd);
    /* Now set the actual length value */
    ui.txLen.value = String(task.message.data.length);

    ui.txId.value = task.message.id.toString(16).toUpperCase();
    writeTxDataUi(task.message.data, task.message.data.length);
    ui.txPeriod.value = String(task.period);
    ui.txComment.value = task.comment || "";
    /* Keep the task's own channel selectable even when it is not up right now. */
    populateTxChannelSelect(state.startedChannels, Number(task.message.channel) || 0);
    showModal("tx");
    updateTxModalDeps();
  }

  /* Controller events (error frames, bus-off, error warning) come from either
   * adapter as a status object.  They land in the same list as received frames,
   * as an ERR row, so both protocols show them in the same place and CLR clears
   * them the same way.
   *
   * The row is keyed by channel + error class(es), not by the decoded detail:
   * the detail holds the error counters, which move on every event, and a key
   * that moves would give every event a row of its own. */
  function upsertStatusRow(status) {
    const classes = Array.isArray(status?.classes) && status.classes.length
      ? status.classes
      : (status?.busoff ? ["bus-off"] : []);
    const type = classes.length ? classes.join("+") : (status?.type || "error");
    const text = describeStatus(status);
    const channel = Number(status?.channel);
    const key = `err-${Number.isFinite(channel) ? channel : "-"}-${type}`;

    const cur = state.rxSummaryMap.get(key) || {
      key,
      channel: Number.isFinite(channel) ? channel : 0,
      id: null,
      type,
      length: 0,
      data: text,
      dataBytes: [],
      cycle: "-",
      count: 0,
      lastTs: null,
      avgCycle: null
    };

    cur.type = type;
    cur.data = text;                        /* the latest detail wins */
    cur.count += 1;

    const ts = Number(status?.timestamp);
    if (cur.lastTs !== null && Number.isFinite(ts) && ts > 0) {
      const delta = Math.max(0, ts - cur.lastTs);
      cur.avgCycle = cur.avgCycle === null ? delta : (cur.avgCycle * 0.7 + delta * 0.3);
      cur.cycle = formatCycleAuto(cur.avgCycle);
    }
    if (Number.isFinite(ts) && ts > 0) cur.lastTs = ts;

    state.rxSummaryMap.set(key, cur);
    scheduleRxSummaryRender();
  }

  /* One error status in the shape can-utils prints an error frame in
   * (snprintf_can_error_frame(), lib.c): a group per error class with that
   * class' payload in braces, comma separated.  A row here can then be compared
   * one to one with `candump -e "canX,#FFFFFFFF"` on the same bus. */
  function describeStatus(status) {
    if (!status) return "error";

    const classes = Array.isArray(status.classes) ? status.classes : [];
    const parts = [];

    if (classes.includes("lost-arbitration")) {
      parts.push(`lost-arbitration{{at bit ${status.arbitrationBit | 0}}}`);
    }
    if (classes.includes("controller-problem")) {
      parts.push(`controller-problem{${(status.ctrl || []).join(",")}}`);
    }
    if (classes.includes("protocol-violation")) {
      const location = status.location ? `{${status.location}}` : "{}";
      parts.push(`protocol-violation{{${(status.prot || []).join(",")}}${location}}`);
    }
    /* The counters belong with the event even when the device does not set
     * CAN_ERR_CNT - can-utils prints them either way (lib.c:873). */
    if (status.txErrorCounter || status.rxErrorCounter) {
      parts.push(`error-counter-tx-rx{{${status.txErrorCounter | 0}}{${status.rxErrorCounter | 0}}}`);
    }
    if (parts.length === 0) {
      parts.push(classes.length ? classes.join(",") : (status.type || "error frame"));
    }
    return parts.join(",");
  }

  /* The ESI bit is a property of the received frame (the controller's error
   * state at that moment), not part of the message's identity: it must not give
   * the message a row of its own.  It only changes the TYPE text, which flashes
   * like any other value when it moves. */
  function rxRowKey(message) {
    return `${message.channel}-${message.id}-${String(message.type).replace(/\s*\bESI\b/, "")}`;
  }

  function upsertRxSummary(message) {
    const key = rxRowKey(message);
    const cur = state.rxSummaryMap.get(key) || {
      key,
      channel: Number(message.channel) || 0,
      id: message.id,
      type: message.type,
      length: 0,
      data: "",
      dataBytes: [],
      cycle: "-",
      count: 0,
      lastTs: null,
      avgCycle: null
    };

    cur.count += 1;
    cur.type = message.type;              /* ESI can move from frame to frame */
    cur.length = message.data.length;
    cur.data = bytesToHexText(message.data);
    cur.dataBytes = message.data.slice();
    if (cur.lastTs !== null && Number.isFinite(message.timestamp)) {
      const delta = Math.max(0, message.timestamp - cur.lastTs);
      cur.avgCycle = cur.avgCycle === null ? delta : (cur.avgCycle * 0.7 + delta * 0.3);
      cur.cycle = formatCycleAuto(cur.avgCycle);
    }
    cur.lastTs = message.timestamp;
    state.rxSummaryMap.set(key, cur);

    scheduleRxSummaryRender();
  }

  function scheduleRxSummaryRender() {
    if (state.rxRenderTimer !== null) return;
    state.rxRenderTimer = setTimeout(() => {
      state.rxRenderTimer = null;
      renderRxSummary();
    }, RX_RENDER_THROTTLE_MS);
  }

  /* RX rows survive between renders: recreating them would restart the flash
   * animation on every repaint (the table is repainted ~12x/s under traffic). */
  function rxRowNode(key) {
    let node = state.rxRows.get(key);
    if (!node) {
      const tr = document.createElement("tr");
      const cells = [];
      for (let i = 0; i < 7; i++) {
        const td = document.createElement("td");
        tr.appendChild(td);
        cells.push(td);
      }
      node = { tr, cells, dataCell: cells[4], byteSpans: [] };
      state.rxRows.set(key, node);
    }
    return node;
  }

  const FLASH_BYTE_MS = 900;
  const FLASH_CELL_MS = 500;             /* count/length tick often: shorter */

  /* The colour a changed value briefly takes, straight out of the theme.  It is
   * its own variable: borrowing --accent made a flash look like part of the
   * normal interface instead of a change. */
  function flashColors() {
    if (flashStyleCached === null) {
      /* read from <body>: the light theme overrides the variables there */
      const css = window.getComputedStyle(document.body);
      flashStyleCached = {
        color: css.getPropertyValue("--flash").trim() || "#ffc978",
        glow: css.getPropertyValue("--flash-glow").trim() || "rgba(255, 201, 120, 0.45)"
      };
    }
    return flashStyleCached;
  }

  /*
   * Fade one changed value from the accent colour back to normal - once.
   *
   * This deliberately runs one animation object per change instead of putting a
   * class on the element.  A class stays behind after the fade, and a browser
   * replays it whenever the element is re-created or its pane is shown again,
   * which lit up rows that had not changed at all.  An animation plays exactly
   * once and leaves no state behind.
   */
  function flashToken(el, durationMs) {
    if (!el) {
      return;
    }

    try {
      const flash = flashColors();
      el.animate(
        [
          { offset: 0, color: flash.color, textShadow: `0 0 6px ${flash.glow}` },
          { offset: 1 }                  /* fades back to whatever it normally is */
        ],
        { duration: durationMs, easing: "ease-out" }
      );
      return;
    } catch (err) {
      /* fall through to the class based fade below */
    }

    el.classList.remove("flash");
    void el.offsetWidth;
    el.classList.add("flash");
    setTimeout(() => el.classList.remove("flash"), durationMs + 60);
  }

  /*
   * ESI is a per-frame state, so it appears and disappears from frame to frame.
   * Reserve its slot with non-breaking spaces when it is absent: the label then
   * has the same width either way and the table stops jittering (a message that
   * reports ESI every other frame used to make the whole row re-flow).
   */
  function typeLabelAligned(typeText) {
    const text = String(typeText);
    if (!text.startsWith("CAN FD") || /\bESI\b/.test(text)) {
      return text;
    }
    return text + "\u00a0\u00a0\u00a0\u00a0";   /* the trailing ESI slot, held open */
  }

  /*
   * Render the type text, colouring the trailing ESI token the same way a
   * changed value is highlighted.  A steady colour, not a flash: ESI can flip
   * every other frame, and an animation that never gets to finish reads as a
   * row that is permanently lit.
   */
  function renderRxType(cell, typeText) {
    const text = typeLabelAligned(typeText);
    const withEsi = /\bESI$/.test(text);
    const base = withEsi ? text.slice(0, -3) : text;

    if (cell._typeBase === base && cell._typeEsi === withEsi) {
      return;                     /* nothing moved: leave the nodes alone */
    }
    cell._typeBase = base;
    cell._typeEsi = withEsi;

    cell.textContent = "";
    cell.appendChild(document.createTextNode(base));
    if (withEsi) {
      const flag = document.createElement("span");
      flag.className = "esi-flag";
      flag.textContent = "ESI";
      cell.appendChild(flag);
    }
  }

  function renderRxSummary() {
    const rows = Array.from(state.rxSummaryMap.values())
      .sort((a, b) => ((a.channel | 0) - (b.channel | 0))
        || (Number(a.id ?? -1) - Number(b.id ?? -1))
        || (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));

    for (const r of rows) {
      const isStatus = (r.id === null || r.id === undefined);
      const node = rxRowNode(r.key);
      const [chCell, idCell, typeCell, lenCell, dataCell, cycleCell, countCell] = node.cells;

      chCell.textContent = channelLabel(r.channel | 0);
      idCell.textContent = isStatus ? "ERR" : `0x${r.id.toString(16).toUpperCase()}`;
      if (isStatus) {
        typeCell.textContent = r.type;
      } else {
        renderRxType(typeCell, r.type);
      }
      lenCell.textContent = isStatus ? "\u00b7" : r.length;
      cycleCell.textContent = r.cycle;
      countCell.textContent = r.count;

      /* the frame counter changes on every frame: flash it on every repaint */
      if (node.lastCount !== undefined && node.lastCount !== r.count) {
        flashToken(countCell, FLASH_CELL_MS);
      }
      node.lastCount = r.count;

      if (node.lastLength !== undefined && node.lastLength !== r.length) {
        flashToken(lenCell, FLASH_CELL_MS);
      }
      node.lastLength = r.length;

      /* The type itself never needs a flash: everything in it but ESI is part of
       * the row's identity, and ESI is handled by its fixed slot above - a bit
       * that flips every other frame would otherwise glow without pause. */

      dataCell.className = "data-cell";
      dataCell.title = r.data;

      if (isStatus) {
        node.byteSpans = [];
        dataCell.textContent = r.data;
        continue;
      }

      /* one span per byte; a byte only flashes when it actually differs from
       * what was on screen before */
      const bytes = r.dataBytes;
      while (node.byteSpans.length < bytes.length) {
        const span = document.createElement("span");
        span.className = "rx-byte";
        node.byteSpans.push(span);
        dataCell.appendChild(span);
        dataCell.appendChild(document.createTextNode(" "));
      }
      const lastBytes = node.lastBytes || [];
      for (let i = 0; i < node.byteSpans.length; i++) {
        const span = node.byteSpans[i];
        const visible = i < bytes.length;
        span.style.display = visible ? "" : "none";
        span.textContent = visible ? (bytes[i] & 0xff).toString(16).padStart(2, "0").toUpperCase() : "";
        if (visible && lastBytes[i] !== undefined && lastBytes[i] !== bytes[i]) {
          flashToken(span, FLASH_BYTE_MS);
        }
      }
      node.lastBytes = bytes.slice();
    }

    /* rows the filter/clear removed */
    for (const [key, node] of state.rxRows) {
      if (!state.rxSummaryMap.has(key)) {
        node.tr.remove();
        state.rxRows.delete(key);
      }
    }

    /* and keep the DOM in sorted order (without needless moves) */
    let previous = null;
    for (const r of rows) {
      const tr = state.rxRows.get(r.key).tr;
      const nextInDom = previous ? previous.nextSibling : ui.rxSummaryBody.firstChild;
      if (nextInDom !== tr) {
        ui.rxSummaryBody.insertBefore(tr, nextInDom);
      }
      previous = tr;
    }
  }

  /* CLR: drop the RX summary and zero every TX frame counter. */
  function clearCounters() {
    state.rxSummaryMap.clear();
    for (const node of state.rxRows.values()) {
      node.tr.remove();
    }
    state.rxRows.clear();
    if (state.rxRenderTimer !== null) {
      clearTimeout(state.rxRenderTimer);
      state.rxRenderTimer = null;
    }
    renderRxSummary();

    for (const task of state.txTasks) {
      task.count = 0;
    }
    if (state.txRenderTimer !== null) {
      clearTimeout(state.txRenderTimer);
      state.txRenderTimer = null;
    }
    renderTxTasks();
  }

  function scheduleTxTasksRender() {
    if (state.txRenderTimer !== null) return;
    state.txRenderTimer = setTimeout(() => {
      state.txRenderTimer = null;

      /* While auto-sending the table is repainted (the frame count changes).
       * The paint replaces the buttons, and a click is only delivered when
       * mousedown and mouseup hit the *same* element - so a repaint in between
       * swallows the click, which made STOP need many attempts.  Hold the
       * repaint while a pointer is held inside the table. */
      if (txPointerHeld()) {
        scheduleTxTasksRender();
        return;
      }

      renderTxTasks();
    }, TX_RENDER_THROTTLE_MS);
  }

  /*
   * Timestamp of a pointer press inside the TX table (0 = no press) and the
   * helper that reports whether repaints must wait.
   */
  let txPointerDownAt = 0;

  /*
   * True while a pointer is held inside the TX table (bounded, in case a
   * pointerup is missed): repaints are deferred meanwhile so button clicks are
   * never split across two DOM nodes.
   */
  function txPointerHeld() {
    return txPointerDownAt !== 0 &&
      (Date.now() - txPointerDownAt) < TX_POINTER_HELD_MAX_MS;
  }

  const DATA_DISPLAY_MAX = 32; /* show at most 32 bytes in cell */

  function fmtDataDisplay(bytes) {
    if (bytes.length === 0) return "(empty)";
    const hex = bytes.map(b => b.toString(16).padStart(2,"0").toUpperCase()).join(" ");
    if (bytes.length <= DATA_DISPLAY_MAX) return hex;
    /* Truncate to first 32 bytes, append "… +N" */
    const head = bytes.slice(0, DATA_DISPLAY_MAX).map(b => b.toString(16).padStart(2,"0").toUpperCase()).join(" ");
    return head + " …+" + bytes.length;
  }

  function fmtDataFull(bytes) {
    if (bytes.length === 0) return "(empty)";
    return bytes.map(b => b.toString(16).padStart(2,"0").toUpperCase()).join(" ");
  }

  /* ---- DEBUG column: what the host tells the device ------------------ */

  const DEBUG_LOG_MAX = 400;

  function debugClockText(ts) {
    const d = new Date(ts);
    const pad = (n, w = 2) => String(n).padStart(w, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  }

  function debugLineNode(entry) {
    const line = document.createElement("div");
    line.className = `dbg-line dbg-${entry.dir} dbg-${entry.kind}`;

    /* the counter keeps the line short; the wall clock is in the hover text */
    const time = document.createElement("span");
    time.className = "dbg-time";
    time.textContent = `#${entry.seq}`;

    const arrow = document.createElement("span");
    arrow.className = "dbg-arrow";
    arrow.textContent = entry.dir === "out" ? "→" : "←";

    const label = document.createElement("span");
    label.className = "dbg-label";
    label.textContent = entry.label;

    const detail = document.createElement("span");
    detail.className = "dbg-detail";
    detail.textContent = entry.brief || "";

    /* the full decode only on hover, so the column stays scannable */
    line.title = [debugClockText(entry.time), entry.label, entry.brief, entry.full]
        .filter(Boolean).join("\n");

    line.append(time, arrow, label, detail);
    return line;
  }

  function debugVisible(entry) {
    /* frames are recorded on request, and hidden again when the box is cleared */
    return (entry.kind !== "tx" && entry.kind !== "rx") || state.debugFrames;
  }

  function refreshDebugCount() {
    ui.debugCount.textContent = `${ui.debugLog.childElementCount} lines`;
  }

  /* Append one entry; the whole log is only rebuilt when the filter changes. */
  function pushDebugEntry(entry) {
    entry.time = Date.now();
    entry.seq = ++state.debugSeq;
    state.debugLog.push(entry);
    while (state.debugLog.length > DEBUG_LOG_MAX) {
      state.debugLog.shift();
    }
    if (!state.debugOn || !debugVisible(entry)) {
      return;
    }

    const log = ui.debugLog;
    const atEnd = log.scrollTop + log.clientHeight >= log.scrollHeight - 6;
    log.appendChild(debugLineNode(entry));
    while (log.childElementCount > DEBUG_LOG_MAX) {
      log.removeChild(log.firstElementChild);
    }
    if (atEnd) {
      log.scrollTop = log.scrollHeight;
    }
    refreshDebugCount();
  }

  function renderDebugLog() {
    const log = ui.debugLog;
    log.textContent = "";
    for (const entry of state.debugLog) {
      if (debugVisible(entry)) {
        log.appendChild(debugLineNode(entry));
      }
    }
    log.scrollTop = log.scrollHeight;
    refreshDebugCount();
  }

  /* Frame records are the expensive part, so the adapter only builds them when
   * this is on. */
  function setDebugFrames(on) {
    state.debugFrames = !!on;
    ui.debugFrames.checked = state.debugFrames;
    if (state.adapter) {
      state.adapter.setDebugOptions({ frames: state.debugFrames });
    }
    if (state.debugOn) {
      renderDebugLog();
    }
  }

  function setDebugMode(on) {
    state.debugOn = !!on;
    document.body.classList.toggle("debug", state.debugOn);
    ui.btnDebug.classList.toggle("active", state.debugOn);
    if (state.debugOn) {
      renderDebugLog();
    }
  }

  /* ---- TX rows: stable nodes + inline quick editing ----------------- */

  function setEditorValue(el, value) {
    /* never fight with the user: a focused editor keeps what is being typed */
    if (document.activeElement !== el && el.value !== value) {
      el.value = value;
    }
  }

  function fillEditorSelect(select, options, value) {
    const signature = options.map((o) => `${o.value}:${o.label}`).join("|");
    if (select.dataset.signature !== signature) {
      select.innerHTML = "";
      for (const o of options) {
        const op = document.createElement("option");
        op.value = String(o.value);
        op.textContent = o.label;
        select.appendChild(op);
      }
      select.dataset.signature = signature;
    }
    if (document.activeElement !== select && select.value !== value) {
      select.value = value;
    }
  }

  /* Enter commits (change already does), Escape puts the stored value back */
  function bindEditorCommit(input, commit) {
    input.addEventListener("change", () => commit(input.value));
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        commit(input.value);
        input.blur();
        ev.preventDefault();
      } else if (ev.key === "Escape") {
        renderTxTasks();
        input.blur();
        ev.preventDefault();
      }
    });
  }

  function txRowNode(task) {
    const existing = state.txRows.get(task.id);
    if (existing) {
      return existing;
    }

    const tr = document.createElement("tr");
    const cells = [];
    const mkCell = () => {
      const td = document.createElement("td");
      tr.appendChild(td);
      cells.push(td);
      return td;
    };

    const [chCell, idCell, typeCell, lenCell, dataCell, cycleCell, countCell, triggerCell, commentCell] =
      [mkCell(), mkCell(), mkCell(), mkCell(), mkCell(), mkCell(), mkCell(), mkCell(), mkCell()];

    /* CH: quick pick of the running channels */
    const chSelect = document.createElement("select");
    chSelect.dataset.edit = "channel";
    chSelect.title = "target CAN channel";
    chSelect.style.cssText = "padding:2px 3px;font-size:.7rem";
    chSelect.addEventListener("change", () => updateTxTaskField(task.id, "channel", chSelect.value));
    chCell.appendChild(chSelect);

    /* MSG ID: hex, select-on-focus, 8 digits means extended */
    const idInput = document.createElement("input");
    idInput.dataset.edit = "id";
    idInput.maxLength = 8;
    idInput.autocomplete = "off";
    idInput.title = "message ID (hex, 8 digits = extended)";
    idInput.style.cssText = "width:6.5em;padding:2px 3px;font-size:.72rem";
    idInput.addEventListener("focus", () => idInput.select());
    idInput.addEventListener("input", () => {
      const clean = idInput.value.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
      if (clean !== idInput.value) {
        idInput.value = clean;               /* only touch it when it is dirty */
      }
    });
    bindEditorCommit(idInput, (value) => updateTxTaskField(task.id, "id", value));
    idCell.appendChild(idInput);

    /* LENGTH: valid sizes for this frame format */
    const lenSelect = document.createElement("select");
    lenSelect.dataset.edit = "length";
    lenSelect.title = "data length";
    lenSelect.style.cssText = "padding:2px 3px;font-size:.7rem";
    lenSelect.addEventListener("change", () => updateTxTaskField(task.id, "length", lenSelect.value));
    lenCell.appendChild(lenSelect);

    /* CYCLE: period in ms, 0 = manual */
    const cycleInput = document.createElement("input");
    cycleInput.dataset.edit = "cycle";
    cycleInput.inputMode = "numeric";
    cycleInput.title = "cycle time in ms (0 = manual)";
    cycleInput.style.cssText = "width:4.5em;padding:2px 3px;font-size:.72rem";
    cycleInput.addEventListener("focus", () => cycleInput.select());
    bindEditorCommit(cycleInput, (value) => updateTxTaskField(task.id, "cycle", value));
    cycleCell.appendChild(cycleInput);

    /* Trigger buttons are created once (the delegated handler owns the clicks) */
    const mkButton = (act, label) => {
      const b = document.createElement("button");
      b.dataset.act = act;
      b.dataset.id = String(task.id);
      b.textContent = label;
      triggerCell.appendChild(b);
      return b;
    };
    const sendBtn = mkButton("send", "SEND");
    const autoBtn = mkButton("auto", "AUTO");
    const editBtn = mkButton("edit", "✎");
    const delBtn = mkButton("del", "✕");

    tr.dataset.taskId = String(task.id);
    tr.title = "double-click sends once · right-click for Add/Edit/Delete";

    const node = {
      tr,
      cells: { ch: chCell, id: idCell, type: typeCell, len: lenCell, data: dataCell, cycle: cycleCell, count: countCell, trigger: triggerCell, comment: commentCell },
      editors: { chSelect, idInput, lenSelect, cycleInput },
      buttons: { send: sendBtn, auto: autoBtn, edit: editBtn, del: delBtn },
      lastCount: undefined
    };
    state.txRows.set(task.id, node);
    return node;
  }

  /* apply an inline edit to the task and repaint the derived cells */
  function updateTxTaskField(taskId, field, rawValue) {
    const task = txTaskById(taskId);
    if (!task) {
      return;
    }

    if (field === "channel") {
      task.message.channel = Math.max(0, Number(rawValue) || 0);
    } else if (field === "id") {
      const digits = String(rawValue || "").trim().replace(/^0x/i, "");
      const id = parseInt(digits, 16);
      if (!Number.isFinite(id)) {
        renderTxTasks();
        return;
      }
      task.message.extended = digits.length > 3;
      task.message.id = (id & (task.message.extended ? 0x1FFFFFFF : 0x7FF)) >>> 0;
    } else if (field === "length") {
      const len = Math.max(0, Math.min(64, Number(rawValue) || 0));
      const data = task.message.data.slice(0, len);
      while (data.length < len) {
        data.push(0);
      }
      task.message.data = data;
    } else if (field === "cycle") {
      const wasAuto = !!task.timer;
      stopTaskTimer(task);
      task.period = Math.max(0, Number(rawValue) || 0);
      if (wasAuto && task.period > 0) {
        startTaskTimer(task);
      }
    }

    renderTxTasks();
  }

  function renderTxTasks() {
    const seen = new Set();

    for (const task of state.txTasks) {
      seen.add(task.id);
      const node = txRowNode(task);
      const running = !!task.timer;
      const hasPeriod = task.period > 0;
      const channel = task.message.channel | 0;

      /* CH: the running channels, plus this task's own (it may point at one
       * that is not started right now) */
      const channelChoices = state.startedChannels.slice();
      if (!channelChoices.includes(channel)) {
        channelChoices.push(channel);
      }
      channelChoices.sort((a, b) => a - b);
      fillEditorSelect(node.editors.chSelect,
        channelChoices.map((c) => ({ value: c, label: channelLabel(c) })), String(channel));

      setEditorValue(node.editors.idInput, `0x${task.message.id.toString(16).toUpperCase()}`);

      const lengths = task.message.fd ? FD_VALID_LENS : [0, 1, 2, 3, 4, 5, 6, 7, 8];
      fillEditorSelect(node.editors.lenSelect,
        lengths.map((v) => ({ value: v, label: String(v) })), String(task.message.data.length));

      setEditorValue(node.editors.cycleInput, String(task.period));

      node.cells.type.textContent = flagsToTypeLabel({
        fd: !!task.message.fd,
        brs: !!task.message.brs,
        rtr: !!task.message.rtr,
        extended: !!task.message.extended
      });
      node.cells.data.className = "data-cell";
      node.cells.data.title = fmtDataFull(task.message.data);
      node.cells.data.textContent = fmtDataDisplay(task.message.data);
      node.cells.comment.className = "comment-cell";
      node.cells.comment.title = task.comment || "";
      node.cells.comment.textContent = task.comment || "";

      node.cells.count.textContent = task.count;
      if (node.lastCount !== undefined && node.lastCount !== task.count) {
        flashToken(node.cells.count, FLASH_CELL_MS);
      }
      node.lastCount = task.count;

      node.buttons.auto.textContent = running ? "STOP" : "AUTO";
      node.buttons.auto.style.display = hasPeriod ? "" : "none";

      node.tr.classList.toggle("selected", state.txSelectedId === task.id);
    }

    for (const [id, node] of state.txRows) {
      if (!seen.has(id)) {
        node.tr.remove();
        state.txRows.delete(id);
      }
    }

    /* keep the DOM in task order; only move what actually needs moving, because
     * re-inserting a node would blur whatever the user is editing inside it */
    let previous = null;
    for (const task of state.txTasks) {
      const tr = state.txRows.get(task.id).tr;
      const nextInDom = previous ? previous.nextSibling : ui.txTaskBody.firstChild;
      if (nextInDom !== tr) {
        ui.txTaskBody.insertBefore(tr, nextInDom);
      }
      previous = tr;
    }
  }

  async function sendTask(task) {
    if (!state.adapter || !state.connected) {
      setStateText("Not connected", "danger");
      return;
    }
    if (!state.busReady) {
      setStateText("Bus not started", "danger");
      return;
    }
    if (task.sending) return;

    const ch = Number(task.message.channel) || 0;
    if (!state.startedChannels.includes(ch)) {
      /* A transmission on a channel that was never started is silently
       * discarded by the firmware (its M_CAN is still in init mode), so refuse
       * it instead of pretending it went out. */
      setStateText(`${channelLabel(ch)} is not started`, "danger");
      return;
    }

    task.sending = true;
    try {
      await state.adapter.sendMessage(task.message);
      task.count += 1;
      scheduleTxTasksRender();
    } catch (err) {
      console.error(err);
      setStateText(`TX ${channelLabel(ch)} failed: ${err?.message || err}`, "danger");
    } finally {
      task.sending = false;
    }
  }

  function txTaskById(id) {
    return state.txTasks.find((t) => t.id === id) || null;
  }

  /* Select a row *in place*: a full repaint on pointerdown would replace the row
   * (and its buttons) under the cursor, which eats clicks that are still held. */
  function paintTxSelection() {
    for (const [id, node] of state.txRows) {
      node.tr.classList.toggle("selected", id === state.txSelectedId);
    }
  }

  function selectTxTask(id) {
    state.txSelectedId = id;
    paintTxSelection();
  }

  function deleteTxTask(id) {
    const task = txTaskById(id);
    if (!task) {
      return;
    }

    const wasSelected = state.txSelectedId === id;
    const index = state.txTasks.findIndex((t) => t.id === id);

    stopTaskTimer(task);
    state.txTasks = state.txTasks.filter((t) => t.id !== id);
    const node = state.txRows.get(id);
    if (node) {
      node.tr.remove();
      state.txRows.delete(id);
    }

    if (wasSelected) {
      /* keep a keyboard workflow going: select the following row (or the last) */
      const next = state.txTasks[Math.min(index, state.txTasks.length - 1)] || null;
      state.txSelectedId = next ? next.id : null;
    }

    renderTxTasks();
    setStateText(`Deleted 0x${task.message.id.toString(16).toUpperCase()}`, "");
  }

  /* candump-style text, so it is also useful outside the page */
  function txTaskToText(task) {
    const m = task.message;
    const id = m.extended
      ? m.id.toString(16).toUpperCase().padStart(8, "0")
      : m.id.toString(16).toUpperCase();
    const data = m.data.map((b) => b.toString(16).padStart(2, "0")).join(" ");
    return `${id}#${m.fd ? "#" : ""}${data}`;
  }

  function copySelectedTxTask() {
    const task = txTaskById(state.txSelectedId);
    if (!task) {
      return false;
    }
    state.txClipboard = {
      extended: task.message.extended,
      fd: task.message.fd,
      brs: task.message.brs,
      rtr: task.message.rtr,
      id: task.message.id,
      data: [...task.message.data],
      period: task.period,
      comment: task.comment || ""
    };
    const text = txTaskToText(task);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => {});
    }
    setStateText(`Copied ${text}`, "ok");
    return true;
  }

  /* <id>#<data> / <id>##<data> (candump style) or "0x123 11 22 33" */
  function parseTxTaskText(text) {
    const clean = String(text || "").trim();
    if (!clean) {
      return null;
    }
    let idPart = "";
    let dataPart = "";
    let fd = false;

    if (clean.includes("#")) {
      const hash = clean.indexOf("#");
      idPart = clean.slice(0, hash);
      dataPart = clean.slice(hash + 1);
      if (dataPart.startsWith("#")) {
        fd = true;
        dataPart = dataPart.slice(1);
      }
    } else {
      const bits = clean.split(/\s+/);
      idPart = bits.shift() || "";
      dataPart = bits.join(" ");
    }

    const id = parseInt(idPart.replace(/^0x/i, ""), 16);
    if (!Number.isFinite(id)) {
      return null;
    }
    const data = (dataPart.match(/[0-9a-fA-F]{2}/g) || []).map((h) => parseInt(h, 16));
    const digits = idPart.replace(/^0x/i, "").length;
    return { id, data, fd, extended: digits > 3 };
  }

  async function pasteTxTask() {
    let clip = state.txClipboard;

    if (!clip && navigator.clipboard && navigator.clipboard.readText) {
      try {
        const parsed = parseTxTaskText(await navigator.clipboard.readText());
        if (parsed) {
          clip = { ...parsed, brs: false, rtr: false, period: 0, comment: "" };
        }
      } catch (e) {
        /* no permission / nothing usable - fall through */
      }
    }
    if (!clip) {
      setStateText("Nothing to paste (copy a TX row first)", "danger");
      return;
    }

    const task = {
      id: state.txTaskSeq++,
      type: flagsToTypeLabel({ fd: !!clip.fd, brs: !!clip.brs, rtr: !!clip.rtr, extended: !!clip.extended }),
      message: new XCanMessage({
        id: clip.id,
        data: [...clip.data],
        extended: !!clip.extended,
        rtr: !!clip.rtr,
        fd: !!clip.fd,
        brs: !!clip.brs,
        esi: false,
        channel: state.startedChannels[0] ?? 0
      }),
      period: Number(clip.period) || 0,
      comment: clip.comment || "",
      count: 0,
      timer: null,
      sending: false
    };
    state.txTasks.push(task);
    state.txSelectedId = task.id;
    renderTxTasks();
    setStateText(`Pasted 0x${task.message.id.toString(16).toUpperCase()}`, "ok");
  }

  function stopTaskTimer(task) {
    if (task.timer) {
      clearTimeout(task.timer);
      task.timer = null;
    }
  }

  function startTaskTimer(task) {
    stopTaskTimer(task);
    if (task.period > 0) {
      /* Chain setTimeout: next send only after current completes.
       * Avoids setInterval pile-up when USB is slower than period. */
      const run = () => {
        if (!task.timer) return; /* stopped mid-chain */
        sendTask(task).finally(() => {
          if (task.timer) {
            task.timer = setTimeout(run, task.period);
          }
        });
      };
      task.timer = setTimeout(run, task.period);
    }
  }

  function collectTxTaskFromUi() {
    const canId = parseInt((ui.txId.value || "").trim(), 16);
    if (!Number.isFinite(canId)) {
      throw new Error("Invalid CAN ID");
    }
    /* a message has to name a channel that is running, otherwise it could not
     * be sent anywhere: the modal is only usable once channels are started */
    const channel = Number(ui.txChannel.value);
    if (!Number.isInteger(channel) || ui.txChannel.value === "") {
      throw new Error("Start a CAN channel before creating messages");
    }
    const flags = collectMsgFlags();
    const message = new XCanMessage({
      id: canId,
      data: getTxDataBytesFromUi(),
      extended: flags.extended,
      rtr: flags.rtr,
      fd: flags.fd,
      brs: flags.brs,
      esi: false,
      channel
    });

    return {
      type: flagsToTypeLabel(flags),
      message,
      period: Math.max(0, Number(ui.txPeriod.value) || 0),
      comment: (ui.txComment.value || "").trim()
    };
  }

  /* Collect the form and commit it (new task, or update the one being edited).
   * Returns true when something was saved. */
  function commitTxTask() {
    /* Add already stored this exact form (and cleared it): Done must not turn
     * the empty form into one more message. */
    if (state.txEditingTaskId === null && state.txFormAlreadyAdded) {
      return true;
    }

    try {
      const next = collectTxTaskFromUi();
      if (state.txEditingTaskId === null) {
        const task = {
          id: state.txTaskSeq++,
          ...next,
          count: 0,
          timer: null,
          sending: false
        };
        state.txTasks.push(task);
        /* Don't auto-start — user must click SEND or START */
      } else {
        const task = state.txTasks.find((t) => t.id === state.txEditingTaskId);
        if (!task) return;
        /* Stop existing timer, update fields, restart only if was running */
        const wasAuto = !!task.timer;
        stopTaskTimer(task);
        task.type = next.type;
        task.message = next.message;
        task.period = next.period;
        task.comment = next.comment;
        task.sending = false;
        if (wasAuto && task.period > 0) startTaskTimer(task);
      }
      state.txEditingTaskId = null;
      renderTxTasks();
      return true;
    } catch (err) {
      console.error(err);
      alert(err.message || String(err));
      return false;
    }
  }

  function saveTxTask() {
    if (commitTxTask()) {
      hideModals();
    }
  }

  /* Same as OK, but keep the panel open with a cleared form so the next message
   * can be added without right-clicking "New Message" again. */
  function saveTxTaskAndAddAnother() {
    if (commitTxTask()) {
      openTxModalForNew({ alreadyAdded: true });
    }
  }

  /* --- channels ------------------------------------------------------- */

  function channelLabel(channel) {
    return `CH${Number(channel) + 1}`;
  }

  /* Channels ticked in the device panel (their "Start" column). */
  function selectedChannelsFromUi() {
    const nCh = state.adapter?.deviceInfo?.channels || 1;
    const channels = [];
    for (let ch = 0; ch < nCh; ch++) {
      if (state.channelSettings[ch]?.start) {
        channels.push(ch);
      }
    }
    return channels;
  }

  function channelSetting(ch) {
    if (!state.channelSettings[ch]) {
      /* where a channel has a switchable terminator it is on by default */
      state.channelSettings[ch] = { start: true, termination: true };
    }
    return state.channelSettings[ch];
  }

  /*
   * One row per channel of the connected device.  Each row carries its own
   * "Start" tick and - where the device/board supports it (gs_usb with a
   * terminator GPIO) - its own termination tick, because termination
   * is a per-channel switch.
   */
  function renderChannelRows() {
    const caps = state.adapter?.deviceInfo?.capabilities || {};
    const nCh = state.adapter?.deviceInfo?.channels || 1;
    const showTerm = !!caps.termination;

    ui.thTerm.style.display = showTerm ? "" : "none";
    ui.channelRows.innerHTML = "";

    for (let ch = 0; ch < nCh; ch++) {
      const setting = channelSetting(ch);
      const tr = document.createElement("tr");

      const cell = (html) => {
        const td = document.createElement("td");
        td.innerHTML = html;
        return td;
      };
      const checkbox = (kind, checked, onChange, title) => {
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = !!checked;
        cb.dataset.channel = String(ch);
        cb.dataset.kind = kind;
        if (title) cb.title = title;
        cb.addEventListener("change", () => onChange(cb.checked));
        return cb;
      };

      tr.appendChild(cell(channelLabel(ch)));

      const startCell = document.createElement("td");
      const stateCell = document.createElement("td");
      startCell.appendChild(checkbox("start", setting.start, (v) => {
        setting.start = v;
        /* Unticking a channel that is up makes it pending (⚠ Apply will stop
         * it).  Repaint just this row's state cell and the Apply marker: a full
         * row rebuild would replace the checkbox that was just clicked, and any
         * reference to it. */
        paintChannelState(stateCell, ch, setting, channelIsPending(ch));
        refreshPendingUi();
      }));
      tr.appendChild(startCell);

      if (showTerm) {
        const termCell = document.createElement("td");
        /* the device tells us what its terminators are doing right now
         * (GS_USB_BREQ_GET_CAN_RESISTER_ENABLE_STATE); the tick is the intent */
        const reported = state.adapter && state.adapter.terminationState
          ? state.adapter.terminationState[ch] : undefined;
        const termTitle = reported === undefined || reported === null
          ? "120 ohm terminator on this channel (device did not report its state)"
          : `120 ohm terminator on this channel. Device currently reports: ${reported ? "on" : "off"}`;
        termCell.appendChild(checkbox("term", setting.termination, (v) => {
          setting.termination = v;
          /* the channel's running config no longer matches: repaint the row so
           * the pending marker and Apply button follow immediately */
          renderChannelRows();
          renderTimingSummary();
        }, termTitle));
        tr.appendChild(termCell);
      }

      /* Per-channel timing: pick a preset right here (the common case needs no
       * dialog at all), or open the dialog for custom work. */
      const timingCell = document.createElement("td");
      const timingSelect = document.createElement("select");
      timingSelect.dataset.timingPreset = String(ch);
      /* sizing lives in #connectModal .compact-table select: the phone layout
       * shrinks it, and an inline style could not be overridden without
       * !important */
      timingSelect.style.cssText = "";
      for (const key of Object.keys(PRESET_TO_BITRATE)) {
        const plan = presetPlan(key, !ui.forceClassic.checked);
        const sp = (plan && plan.nominal)
          ? ` @${(plan.nominal.samplePoint * 100).toFixed(0)}%${plan.data ? `/${(plan.data.samplePoint * 100).toFixed(0)}%` : ""}`
          : "";
        const op = document.createElement("option");
        op.value = key;
        op.textContent = `${fmtPresetKey(key)}${sp}`;
        timingSelect.appendChild(op);
      }
      const t = channelTiming(ch);
      const parts = timingLabelParts(ch);
      const isCustom = !!(t.nominal || t.data);

      /* A channel that has customised phases must not pretend to sit on a
       * preset: the dropdown then carries a single "Custom — <its parameters>"
       * entry (and nothing else to pick but a preset, which resets it). */
      if (isCustom) {
        const customOp = document.createElement("option");
        customOp.value = "__custom";
        customOp.textContent = `Custom — ${parts.text.replace(/ custom$/, "")}`;
        customOp.title = parts.detail;
        timingSelect.appendChild(customOp);
      }

      timingSelect.value = isCustom ? "__custom" : t.presetKey;
      timingSelect.title = isCustom
        ? `custom timings (${parts.detail.replace(/\n/g, "  ")}) — pick a preset to reset this channel`
        : "preset for this channel (resets both phases)";
      timingSelect.addEventListener("change", () => {
        if (timingSelect.value === "__custom") {
          return;                            /* just the state indicator */
        }
        const tt = channelTiming(ch);
        tt.presetKey = timingSelect.value;
        tt.nominal = null;
        tt.data = null;
        renderChannelRows();
        renderTimingSummary();
      });

      /* One gear per phase: clicking one means "custom for that phase", which is
       * why the sub-panel behind it has no preset logic. */
      const gear = (phase, label) => {
        const b = document.createElement("button");
        b.className = "tool-icon";
        b.dataset.timing = String(ch);
        b.dataset.phase = phase;
        b.textContent = label;
        const custom = !!t[phase];
        b.title = `${channelLabel(ch)} ${phase === "data" ? "data (FD/BRS)" : "arbitration"} timing: `
          + `${custom ? "custom" : "preset"} — pick bitrate + sample point`;
        b.style.marginLeft = "4px";
        if (custom) {
          b.style.color = "var(--accent)";
        }
        b.addEventListener("click", () => openTimingModal(ch, phase));
        return b;
      };

      timingCell.appendChild(timingSelect);
      timingCell.appendChild(gear("nominal", "⚙ arb"));
      if (!ui.forceClassic.checked) {
        timingCell.appendChild(gear("data", "⚙ data"));
      }
      tr.appendChild(timingCell);

      /* State column: running / pending (the device no longer matches the
       * panel: settings changed, or the channel was unticked) / idle. */
      paintChannelState(stateCell, ch, setting, channelIsPending(ch));
      tr.appendChild(stateCell);

      ui.channelRows.appendChild(tr);
    }
  }

  function openDevicePanel() {
    if (!state.connected) return;
    renderChannelRows();
    renderTimingSummary();
    setStateText("Configure bus…", "");
    showModal("connect");
  }

  /* The toolbar Start/Stop and the panel button show the same thing. */
  function syncStartStopButtons() {
    const running = state.startedChannels.length > 0;
    const label = running ? "⏹ Stop" : "▶ Start";
    for (const b of [ui.btnStartStop, ui.btnStartBus]) {
      if (!b) continue;
      b.textContent = label;
      b.disabled = !state.connected;
    }
    if (ui.btnStartStop) {
      ui.btnStartStop.title = running ? "Stop the bus" : "Start the bus";
    }
  }

  /* TX messages choose their target channel here.  Only *started* channels are
   * offered.  `extra` (used while editing) keeps a channel that is not up right
   * now in the list, so editing an existing message cannot silently move it to
   * another channel. */
  function populateTxChannelSelect(channels, extra = null) {
    const prev = ui.txChannel.value;
    const list = channels.slice();

    if (extra !== null && !list.includes(extra)) {
      list.push(extra);
      list.sort((a, b) => a - b);
    }

    ui.txChannel.innerHTML = "";
    for (const c of list) {
      const op = document.createElement("option");
      op.value = String(c);
      op.textContent = channels.includes(c)
        ? `${channelLabel(c)} (bus ${c})`
        : `${channelLabel(c)} (not started)`;
      ui.txChannel.appendChild(op);
    }

    let wanted = "";
    if (extra !== null) {
      wanted = String(extra);
    } else if (prev && list.some((c) => String(c) === prev)) {
      wanted = prev;
    } else if (channels.length) {
      wanted = String(channels[0]);
    }

    if (wanted !== "") {
      ui.txChannel.value = wanted;
    }
  }

  /* Everything the panel defines for one channel: its own timing (preset or the
   * custom registers), its own termination, and the shared flags.  `snapshot`
   * (from the last Start) is used by RST to re-initialise what was running. */
  function buildBusConfig(channel, snapshot) {
    const caps = state.adapter?.deviceInfo?.capabilities || {};
    const fdMode = snapshot ? snapshot.fdMode : !ui.forceClassic.checked;
    const listenOnly = snapshot ? snapshot.listenOnly : !!ui.listenOnly.checked;
    const t = snapshot ? snapshot.perChannel[channel].timing : channelTiming(channel);
    const presetKey = t.presetKey || ui.preset.value;
    const bits = PRESET_TO_BITRATE[presetKey] || PRESET_TO_BITRATE[Object.keys(PRESET_TO_BITRATE)[0]];

    const cfg = {
      channel,
      nominalBitrate: bits.nominal,
      dataBitrate: bits.data,
      listenOnly,
      fdMode
    };

    if (t.nominal || t.data) {
      cfg.customTiming = {
        nominal: t.nominal || null,
        data: fdMode ? (t.data || null) : null
      };
    }

    if (caps.termination) {
      cfg.termination = snapshot
        ? !!snapshot.perChannel[channel].termination
        : !!channelSetting(channel).termination;
    }

    return new XCanConfig(cfg);
  }

  /* Snapshot of the panel for RST: what is running right now, per channel. */
  function snapshotBusConfig() {
    const snapshot = {
      listenOnly: !!ui.listenOnly.checked,
      fdMode: !ui.forceClassic.checked,
      perChannel: {}
    };
    for (const ch of state.startedChannels) {
      const t = channelTiming(ch);
      snapshot.perChannel[ch] = {
        termination: !!channelSetting(ch).termination,
        timing: cloneTiming(t)
      };
    }
    return snapshot;
  }

  /* ---------------- bit timing (per channel) ------------------------ */

  function cloneTiming(t) {
    return {
      presetKey: t.presetKey,
      nominal: t.nominal ? { ...t.nominal } : null,
      data: t.data ? { ...t.data } : null,
      query: {
        nominal: { ...t.query.nominal },
        data: { ...t.query.data }
      }
    };
  }

  /* Human-readable bitrate: 1 Mbps is "1M", not "1000k". */
  function fmtBitrateShort(hz) {
    if (hz >= 1e6) {
      const m = hz / 1e6;
      return `${Number.isInteger(m) ? m : m.toFixed(2)}M`;
    }
    const k = hz / 1000;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
  }

  /*
   * "80 %" for a whole percentage, "81.3 %" otherwise.  The solver prefers round
   * sample points (see _calcBitTiming), so the common case reads as an integer -
   * a trailing ".0" on every one of them would just be noise.
   */
  function fmtSamplePoint(ratio) {
    const pct = Math.round(ratio * 1000) / 10;
    return `${Number.isInteger(pct) ? pct : pct.toFixed(1)}%`;
  }

  function fmtPresetKey(key) {
    const bits = PRESET_TO_BITRATE[key];
    return bits ? `${fmtBitrateShort(bits.nominal)} / ${fmtBitrateShort(bits.data)}` : key;
  }

  function debounce(fn, ms = 150) {
    let timer = null;
    return (...args) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; fn(...args); }, ms);
    };
  }

  /* Per-channel timing.  Each phase is either the preset's solved values
   * (`null`) or the user's own registers - no channel-wide "mode" to keep in
   * sync, and customising one phase never touches the other. */
  function channelTiming(ch) {
    if (!state.channelTiming[ch]) {
      state.channelTiming[ch] = {
        presetKey: ui.preset.value || Object.keys(PRESET_TO_BITRATE)[0],
        nominal: null,
        data: null,
        query: {
          nominal: { bitrate: 500, sample: 80 },
          data: { bitrate: 2000, sample: 80 }
        }
      };
    }
    return state.channelTiming[ch];
  }

  /* Clock and ranges the candidate table is built from.  gs_usb reports both
   * (fixed clock from BT_CONST, ranges from BT_CONST / BT_CONST_EXT). */
  function timingContext(phase) {
    const adapter = state.adapter;
    const isData = phase === "data";
    const lim = adapter?.timingLimits
      ? (isData ? adapter.timingLimits.data : adapter.timingLimits.nominal)
      : null;
    const fclk = isData
      ? (adapter?.capFd?.fclk_can || adapter?.canClockHz)
      : adapter?.canClockHz;
    return { lim, fclk: fclk || 80e6 };
  }

  /* What the adapter would program for a preset - pure calculation, no USB, and
   * the very same solver that is used when the bus is started. */
  function presetPlan(presetKey, fdMode) {
    const adapter = state.adapter;
    const bits = PRESET_TO_BITRATE[presetKey] || PRESET_TO_BITRATE[Object.keys(PRESET_TO_BITRATE)[0]];
    if (!adapter || typeof adapter.planPreset !== "function" || !bits) {
      return null;
    }
    const wrap = (t) => t ? ({
      origin: "preset",
      values: { brp: t.brp, seg1: t.seg1, seg2: t.seg2, sjw: t.sjw },
      fclk: t.fclk,
      bitrateHz: t.bitrateHz,
      samplePoint: t.samplePoint,
      err: 0
    }) : null;

    try {
      const plan = adapter.planPreset({
        nominalBitrate: bits.nominal,
        dataBitrate: bits.data,
        fdMode: fdMode !== false
      });
      return plan ? { nominal: wrap(plan.nominal), data: wrap(plan.data) } : null;
    } catch (e) {
      console.warn("[web-can-utils] preset preview failed:", e);
      return null;
    }
  }

  /*
   * What one phase will be programmed with: the channel's own registers, or the
   * preset's solved timing - always as real bitrate + sample point, so the UI
   * never shows registers the user has to interpret.
   */
  function timingResult(ch, phase, t) {
    const tt = t || channelTiming(ch);
    const { fclk } = timingContext(phase);
    const custom = tt[phase];

    if (custom) {
      const brp = Number(custom.brp);
      const seg1 = Number(custom.seg1 ?? custom.tseg1);
      const seg2 = Number(custom.seg2 ?? custom.tseg2);
      const sjw = Number(custom.sjw ?? 1);
      if (![brp, seg1, seg2].every((v) => Number.isFinite(v) && v > 0)) {
        return null;
      }
      const want = (phase === "data" ? tt.query.data.bitrate : tt.query.nominal.bitrate) * 1000;
      const bitrateHz = fclk / (brp * (1 + seg1 + seg2));
      return {
        origin: "custom",
        values: { brp, seg1, seg2, sjw },
        fclk,
        bitrateHz,
        samplePoint: (1 + seg1) / (1 + seg1 + seg2),
        err: want > 0 ? Math.abs(bitrateHz - want) / want : 0
      };
    }

    const plan = presetPlan(tt.presetKey, !ui.forceClassic.checked);
    return (plan && (phase === "data" ? plan.data : plan.nominal)) || null;
  }

  function fmtResult(res) {
    if (!res) return "not available for this device";
    const regs = `brp${res.values.brp} tseg1 ${res.values.seg1} tseg2 ${res.values.seg2} sjw${res.values.sjw}`;
    const err = res.err > 0.0005 ? `   (${(res.err * 100).toFixed(2)}% off target)` : "";
    return `${(res.bitrateHz / 1000).toFixed(3)}k @ ${fmtSamplePoint(res.samplePoint)}  —  ${regs}${err}`;
  }

  /* Compact row label ("500k@80% / 2M@80% custom") plus the register detail for
   * the tooltip. */
  function timingLabelParts(ch) {
    const t = channelTiming(ch);
    const n = timingResult(ch, "nominal", t);
    const d = timingResult(ch, "data", t);
    const short = (r) => r
      ? `${fmtBitrateShort(r.bitrateHz)}@${fmtSamplePoint(r.samplePoint)}`
      : "?";
    const detail = [n, d].filter(Boolean).map((r) => fmtResult(r)).join("\n");
    const custom = !!(t.nominal || t.data) ? " custom" : "";
    return {
      text: `${short(n)}${d ? ` / ${short(d)}` : ""}${custom}`,
      detail
    };
  }

  /* Everything that defines a channel's configuration, as a comparable string. */
  function configKey({ timing, termination, fdMode, listenOnly }) {
    return JSON.stringify({
      presetKey: timing.presetKey,
      nominal: timing.nominal,
      data: timing.data,
      termination: !!termination,
      fdMode: !!fdMode,
      listenOnly: !!listenOnly
    });
  }

  function configKeyFor(ch) {
    return configKey({
      timing: channelTiming(ch),
      termination: channelSetting(ch).termination,
      fdMode: !ui.forceClassic.checked,
      listenOnly: !!ui.listenOnly.checked
    });
  }

  /* The row's state cell: running / pending / pending stop (unticked, so ⚠ Apply
   * will stop it) / stopped / idle.  Its own function because the Start tick
   * repaints just this cell in place - rebuilding the rows there would replace
   * the checkbox the user just clicked. */
  function paintChannelState(cell, ch, setting, pending) {
    const text = state.startedChannels.includes(ch)
      ? (pending && !setting.start ? "pending stop"
        : (pending ? "pending" : "running"))
      : (state.busReady ? "stopped" : "idle");

    cell.innerHTML = pending ? `<span style="color:var(--accent)">${text} ⚠</span>` : text;
  }

  /* A started channel whose state on the device no longer matches the panel: its
   * settings were changed, or it is not ticked for Start any more (Apply stops
   * those instead of programming them). */
  function channelIsPending(ch) {
    if (!state.startedChannels.includes(ch)) {
      return false;
    }
    return !channelSetting(ch).start || state.runningConfig[ch] !== configKeyFor(ch);
  }

  /* Started channels the ⚠ Apply button has work to do on. */
  function pendingChannels() {
    return state.startedChannels.filter(channelIsPending);
  }

  function refreshPendingUi() {
    const pending = pendingChannels();
    if (ui.btnApplyPending) {
      ui.btnApplyPending.disabled = pending.length === 0;
      ui.btnApplyPending.textContent = "⚠ Apply";
      ui.btnApplyPending.title = pending.length
        ? `pending settings on ${pending.map(channelLabel).join(", ")} — Apply re-initialises the ticked channels and stops the unticked ones`
        : "no pending changes";
    }
    if (ui.btnStartStop && state.startedChannels.length) {
      ui.btnStartStop.title = pending.length
        ? `pending timing/settings on ${pending.map(channelLabel).join(", ")} — Apply, or Stop+Start`
        : "Stop the bus";
    }
  }

  /* Preset labels carry the sample point they resolve to. */
  function renderPresetOptions(select, selectedKey) {
    if (!select) return;
    const keep = selectedKey || select.value;
    select.innerHTML = "";
    for (const key of Object.keys(PRESET_TO_BITRATE)) {
      const plan = presetPlan(key, !ui.forceClassic.checked);
      const sp = (plan && plan.nominal)
        ? ` — SP ${fmtSamplePoint(plan.nominal.samplePoint)}${plan.data ? ` / ${fmtSamplePoint(plan.data.samplePoint)}` : ""}`
        : "";
      const op = document.createElement("option");
      op.value = key;
      op.textContent = `${fmtPresetKey(key)}${sp}`;
      if (plan) op.title = `${fmtPresetKey(key)}: ${describePlan(plan).replace(/\n/g, "   ")}`;
      select.appendChild(op);
    }
    if (keep && Array.from(select.options).some((o) => o.value === keep)) {
      select.value = keep;
    }
  }

  function describePlan(plan) {
    if (!plan || !plan.nominal) return "not reported by this device";
    return plan.data
      ? `nominal ${fmtResult(plan.nominal)}\ndata    ${fmtResult(plan.data)}`
      : `nominal ${fmtResult(plan.nominal)}`;
  }

  /* Panel refresher: preset option labels (with their sample points), the clock
   * line and the pending marker.  Explanations live in title attributes. */
  function renderTimingSummary() {
    renderPresetOptions(ui.preset, ui.preset.value);

    const hz = state.adapter?.canClockHz || 0;
    if (hz) {
      ui.clockInfo.textContent = `Clock ${(hz / 1e6).toFixed(3)} MHz`;
      ui.clockInfo.title = "fixed CAN clock reported by the device (GS_USB_BREQ_BT_CONST)";
    } else {
      ui.clockInfo.textContent = "";
      ui.clockInfo.title = "";
    }
    refreshPendingUi();
  }

  function applyPresetToAllChannels() {
    const key = ui.preset.value;
    const nCh = state.adapter?.deviceInfo?.channels || 1;
    for (let ch = 0; ch < nCh; ch++) {
      const t = channelTiming(ch);
      t.presetKey = key;
      t.nominal = null;
      t.data = null;
    }
    renderChannelRows();
    renderTimingSummary();
    setStateText(`Preset ${fmtPresetKey(key)} applied to all channels`, "ok");
  }

  /* ---- candidate table ------------------------------------------- */

  function timingCandidates(fclk, bitrateHz, lim, samplePoint) {
    const limits = lim || {};
    const brpMin = limits.brp_min || 1;
    const brpMax = limits.brp_max || 1024;
    const inc = Math.max(1, limits.brp_inc || 1);
    const seg1Min = limits.seg1_min || 1;
    const seg1Max = limits.seg1_max || 256;
    const seg2Min = limits.seg2_min || 1;
    const seg2Max = limits.seg2_max || 128;
    const want = Math.max(1, Math.min(99, Number(samplePoint) || 80)) / 100;
    const rows = [];

    for (let brp = brpMin; brp <= brpMax; brp += inc) {
      const total = Math.round(fclk / (brp * bitrateHz)) - 1;
      if (!Number.isFinite(total) || total < 3) continue;

      for (let off = -4; off <= 4; off++) {
        const seg1 = Math.round((total + 1) * want) - 1 + off;
        const seg2 = total - seg1;
        if (seg1 < seg1Min || seg1 > seg1Max || seg2 < seg2Min || seg2 > seg2Max) continue;

        const realHz = fclk / (brp * (1 + seg1 + seg2));
        rows.push({
          brp, seg1, seg2,
          sjw: Math.max(1, Math.min(seg2, limits.sjw_max || 1, 4)),
          realHz,
          err: Math.abs(realHz - bitrateHz) / bitrateHz,
          sp: (1 + seg1) / (1 + seg1 + seg2)
        });
      }
    }

    const seen = new Set();
    return rows
      .filter((r) => r.err <= 0.02)
      .sort((a, b) => (Math.abs(a.sp - want) - Math.abs(b.sp - want)) || (a.err - b.err))
      .filter((r) => {
        const key = `${r.brp}|${r.seg1}|${r.seg2}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 40);
  }

  /* ---- dialog (edits a draft; OK/Done commit, Cancel discards) ---- */

  function draftTiming() {
    if (!state.timingDraft) {
      state.timingDraft = cloneTiming(channelTiming(state.timingChannel));
    }
    return state.timingDraft;
  }

  function renderTimingTable(phase) {
    const isData = phase === "data";
    const table = isData ? ui.dataTable : ui.nomTable;
    const t = draftTiming();
    const query = t.query[phase];
    const { lim, fclk } = timingContext(phase);
    const chosen = t[phase];

    table.innerHTML = "";

    if (!lim) {
      return;
    }

    const rows = timingCandidates(fclk, query.bitrate * 1000, lim, query.sample);
    for (const r of rows) {
      const tr = document.createElement("tr");
      const isChosen = !!chosen && chosen.brp === r.brp
        && (chosen.seg1 ?? chosen.tseg1) === r.seg1
        && (chosen.seg2 ?? chosen.tseg2) === r.seg2;
      if (isChosen) tr.style.background = "rgba(54,194,255,0.18)";
      tr.style.cursor = "pointer";
      tr.title = "use this timing for this phase";
      tr.innerHTML =
        `<td>${r.brp}</td><td>${r.seg1}</td><td>${r.seg2}</td><td>${r.sjw}</td>` +
        `<td>${(r.realHz / 1000).toFixed(3)}k</td>` +
        `<td>${(r.err * 100).toFixed(2)}%</td>` +
        `<td>${(r.sp * 100).toFixed(1)}%</td>` +
        `<td>${isChosen ? "\u2713" : ""}</td>`;
      tr.addEventListener("click", () => useTimingCandidate(phase, r));
      table.appendChild(tr);
    }
  }

  /* Typing a bitrate/sample point resolves the phase immediately (the best
   * candidate is picked for you); the table is only for looking at alternatives. */
  function autoSelectTop(phase) {
    const t = draftTiming();
    const { lim, fclk } = timingContext(phase);
    if (!lim) return;
    const query = t.query[phase];
    const top = timingCandidates(fclk, query.bitrate * 1000, lim, query.sample)[0];
    if (top) {
      t[phase] = { brp: top.brp, seg1: top.seg1, seg2: top.seg2, sjw: top.sjw };
    }
  }

  function renderTimingResults() {
    const ch = state.timingChannel;
    const t = draftTiming();
    const phase = state.timingPhase;
    const res = timingResult(ch, phase, t);
    const line = `${res && res.origin === "custom" ? "custom:" : "preset:"} ${fmtResult(res)}`;
    if (phase === "data") {
      ui.dataResult.textContent = line;
    } else {
      ui.nomResult.textContent = line;
    }
  }

  function useTimingCandidate(phase, cand) {
    const t = draftTiming();
    t[phase] = { brp: cand.brp, seg1: cand.seg1, seg2: cand.seg2, sjw: cand.sjw };
    renderTimingTable(phase);
    renderTimingResults();
  }

  function readTimingQuery(phase) {
    const isData = phase === "data";
    const t = draftTiming();
    const bitrate = Number((isData ? ui.dataBitrate : ui.nomBitrate).value) || 0;
    const sample = Number((isData ? ui.dataSample : ui.nomSample).value) || 80;
    if (bitrate > 0) {
      t.query[phase] = { bitrate, sample };
    }
    return bitrate > 0;
  }

  const refreshNominal = debounce(() => {
    if (!readTimingQuery("nominal")) return;
    autoSelectTop("nominal");
    renderTimingTable("nominal");
    renderTimingResults();
  });

  const refreshData = debounce(() => {
    if (!readTimingQuery("data")) return;
    autoSelectTop("data");
    renderTimingTable("data");
    renderTimingResults();
  });

  function renderTimingDialog() {
    const ch = state.timingChannel;
    const t = draftTiming();
    const adapter = state.adapter;

    ui.timingTitle.textContent = `Bit Timing — ${channelLabel(ch)} · ${state.timingPhase === "data" ? "data (FD/BRS)" : "arbitration"}`;
    ui.nominalPhase.style.display = state.timingPhase === "nominal" ? "" : "none";
    ui.dataPhase.style.display = state.timingPhase === "data" ? "" : "none";

    ui.timingClock.textContent = adapter?.canClockHz
      ? `${(adapter.canClockHz / 1e6).toFixed(3)} MHz`
      : "unknown";
    ui.timingClock.title = "fixed CAN clock reported by the device";

    ui.nomBitrate.value = String(t.query.nominal.bitrate);
    ui.nomSample.value = String(t.query.nominal.sample);
    ui.dataBitrate.value = String(t.query.data.bitrate);
    ui.dataSample.value = String(t.query.data.sample);

    renderTimingTable(state.timingPhase);
    renderTimingResults();
  }

  /* The timing dialog is a sub-panel of the device panel: it opens on top of it
   * and closing it leaves the device panel (not the main page) in place, so the
   * next channel can be configured right away. */
  function openTimingOverlay() {
    ui.modalBackdrop.classList.add("show");
    ui.timingModal.classList.add("show");
  }

  function closeTimingOverlay() {
    ui.timingModal.classList.remove("show");
    if (!ui.connectModal.classList.contains("show")) {
      ui.modalBackdrop.classList.remove("show");
    }
  }

  function openTimingModal(ch, phase) {
    if (!state.connected) return;
    if (ch === undefined || ch === null) {
      ch = selectedChannelsFromUi()[0] ?? 0;
    }
    state.timingChannel = Number(ch);
    state.timingPhase = phase === "data" ? "data" : "nominal";
    state.timingDraft = null;
    ui.connectModal.classList.add("show");
    renderTimingDialog();
    openTimingOverlay();
  }

  function commitTimingDraft() {
    if (!state.timingDraft) {
      return;
    }
    state.channelTiming[state.timingChannel] = state.timingDraft;
    state.timingDraft = null;
    renderChannelRows();
    renderTimingSummary();
  }

  function discardTimingDraft() {
    state.timingDraft = null;
    renderChannelRows();
    closeTimingOverlay();
  }

  /* OK: this channel is done - commit it and go back to the device panel. */
  function acceptTimingDialog() {
    commitTimingDraft();
    closeTimingOverlay();
  }

  /* Program the running channels with the settings above (pending changes).
   * A pending channel that is no longer ticked for Start is *stopped* instead of
   * being re-initialised: initBus() always ends with MODE_START, so programming
   * an unticked channel would start it again - which is exactly what made
   * "untick CH3/CH4 and Apply" put them back on the bus. */
  async function applyPendingConfig() {
    if (!state.adapter || !state.connected) return;
    const pending = pendingChannels();
    if (pending.length === 0) {
      setStateText("No pending changes", "");
      return;
    }

    const applied = [];
    const stopped = [];

    try {
      for (const ch of pending) {
        await state.adapter.resetBus(ch);

        if (channelSetting(ch).start) {
          await state.adapter.initBus(buildBusConfig(ch));
          state.runningConfig[ch] = configKeyFor(ch);
          applied.push(ch);
        } else {
          /* Unticked: it stays down, so it is no longer a running channel. */
          delete state.runningConfig[ch];
          state.startedChannels = state.startedChannels.filter((c) => c !== ch);
          stopped.push(ch);
        }
      }

      state.busReady = state.startedChannels.length > 0;

      if (stopped.length) {
        /* A stopped channel must not keep sending: drop the periodic tasks that
         * target it, like Stop does (for all of them). */
        for (const t of state.txTasks) {
          if (stopped.includes(Number(t.message?.channel))) {
            stopTaskTimer(t);
          }
        }
        populateTxChannelSelect(state.startedChannels);
        renderTxTasks();
      }

      const parts = [];
      if (applied.length) parts.push(`Applied (${applied.map(channelLabel).join(", ")})`);
      if (stopped.length) parts.push(`Stopped (${stopped.map(channelLabel).join(", ")})`);
      setStateText(parts.join(" · "), "ok");
    } catch (err) {
      console.error(err);
      setStateText(`Apply failed: ${err?.message || err}`, "danger");
    } finally {
      renderChannelRows();
      renderTimingSummary();
      syncStartStopButtons();
      updateDeviceChips();
      syncConnectButton();
    }
  }

  /* Connect: pick device → query info → show bus config modal */  /* Connect: pick device → query info → show bus config modal */  /* Connect: pick device → query info → show bus config modal */
  async function doConnect() {
    try {
      const protocol = ui.protocolSelect.value;
      if (!protocol) return;

      const adapter = xcanRegistry.create(protocol);
      if (!adapter) throw new Error("Protocol not found");

      adapter.onReceive((message) => upsertRxSummary(message));
      adapter.onDebug((entry) => pushDebugEntry(entry));
      adapter.setDebugOptions({ frames: state.debugFrames });
      adapter.onStatus((status) => upsertStatusRow(status));
      adapter.onError((e) => {
        /* Surface transport errors - a dead RX loop or a stalled USB transfer
         * also stops transmissions, and the console is not always open. */
        console.error(e);
        setStateText(e?.message || String(e), "danger");
      });

      state.adapter = adapter;

      /* 1. Pick device (WebUSB dialog) */
      await state.adapter.requestDevice();

      /* 2. Connect + query */
      await state.adapter.connect();
      state.connected = true;

      const info = state.adapter.deviceInfo;
      const nCh = info.channels || 1;

      /* 3. Populate the channel list (every channel ticked).  The TX target
       *    selector only lists *started* channels, so it stays empty until the
       *    bus is up. */
      /* Fresh per-channel panel state (every channel ticked to start, no
       * termination) and default timing selection for this device. */
      state.channelSettings = {};
      for (let c = 0; c < nCh; c++) {
        state.channelSettings[c] = {
          start: true,
          termination: !!(info.capabilities && info.capabilities.termination)
        };
      }
      state.startedChannels = [];
      state.busReady = false;
      state.channelTiming = {};
      state.runningConfig = {};
      state.timingDraft = null;
      state.timingChannel = 0;
      for (let c = 0; c < nCh; c++) {
        channelTiming(c);
      }

      populateTxChannelSelect([]);
      renderChannelRows();
      renderTimingSummary();
      renderPresetOptions(ui.preset, ui.preset.value);
      syncStartStopButtons();

      const caps = info.capabilities || {};
      /*
       * One element per field.  As a single string this line could only break
       * wherever the browser ran out of room, which cut "S/N <uid>" or
       * "Listen-Only" in half; the panel is deliberately narrow (see
       * #connectModal), so the wrap is the normal case on a phone.  The "|"
       * separators are added by CSS (::after on the field that precedes them),
       * which keeps a wrapped line from starting with a pipe.
       */
      const deviceFields = [
        info.name,
        `FW ${info.firmware}`,
        `HW ${info.hardware}`,
        `${nCh} channel(s)`,
        `FD ${caps.fd ? "\u2713" : "\u2717"}`,
        `BRS ${caps.brs ? "\u2713" : "\u2717"}`,
        `Listen-Only ${caps.listenOnly ? "\u2713" : "\u2717"}`,
        `Termination ${caps.termination ? "\u2713" : "\u2717"}`
      ];
      if (info.serial && info.serial !== "Unknown") {
        deviceFields.push(`S/N ${info.serial}`);
      }

      ui.deviceInfoPlaceholder.innerHTML = "";
      for (const text of deviceFields) {
        const el = document.createElement("span");
        el.className = "dev-item";
        el.textContent = text;
        ui.deviceInfoPlaceholder.appendChild(el);
      }

      updateDeviceChips();
      syncConnectButton();
      setStateText("Configure bus…", "");

      /* 4. Show bus config modal */
      showModal("connect");
    } catch (err) {
      console.error(err);
      setStateText("Connect failed", "danger");
      if (state.adapter) {
        try { state.adapter.disconnect(); } catch (_) {}
        state.adapter = null;
      }
      state.connected = false;
      syncConnectButton();
    }
  }

  /* Start the selected channel(s) from the bus config modal.  gs_usb can run
   * several channels at once; adapters without that ability only get the first
   * selected channel.  Starting again while channels are up re-initialises them
   * with the settings in the modal (and stops the ones that are no longer
   * ticked). */
  async function doStartBus() {
    try {
      if (!state.adapter || !state.connected) return;

      let channels = selectedChannelsFromUi();
      if (channels.length === 0) {
        setStateText("Select at least one channel", "danger");
        return;
      }

      /* Channels that are up but no longer selected must go down, otherwise
       * the UI would claim a bus state the hardware does not have. */
      for (const ch of state.startedChannels.slice()) {
        if (!channels.includes(ch)) {
          try {
            await state.adapter.resetBus(ch);
          } catch (err) {
            console.warn(`[web-can-utils] stopping channel ${ch} failed:`, err);
          }
        }
      }

      const started = [];
      const failed = [];

      for (const ch of channels) {
        try {
          await state.adapter.initBus(buildBusConfig(ch));
          started.push(ch);
        } catch (err) {
          console.error(`[web-can-utils] starting channel ${ch} failed:`, err);
          failed.push(ch);
        }
      }

      if (started.length === 0) {
        setStateText("Bus init failed", "danger");
        return;
      }

      await state.adapter.startReceive();

      state.startedChannels = started;
      state.busReady = true;
      state.lastBusConfig = snapshotBusConfig();
      state.runningConfig = {};
      for (const ch of started) {
        state.runningConfig[ch] = configKeyFor(ch);
      }
      populateTxChannelSelect(started);
      updateDeviceChips();
      syncConnectButton();
      renderChannelRows();
      renderTimingSummary();
      syncStartStopButtons();
      hideModals();

      const names = started.map(channelLabel).join(", ");
      const notes = [];
      if (failed.length) notes.push(`failed ${failed.map(channelLabel).join(", ")}`);
      setStateText(notes.length ? `Connected ${names} — ${notes.join("; ")}` : `Connected ${names}`,
        notes.length ? "danger" : "ok");
    } catch (err) {
      console.error(err);
      setStateText("Bus init failed", "danger");
    }
  }

  /* Disconnect from config modal */
  async function doDisconnectFromModal() {
    if (state.busReady) {
      try { await state.adapter.stopReceive(); } catch (_) {}
      state.busReady = false;
    }
    if (state.adapter && state.connected) {
      try { await state.adapter.disconnect(); } catch (_) {}
    }
    state.adapter = null;
    state.connected = false;
    state.busReady = false;
    state.startedChannels = [];
    state.busReady = false;
    ui.channelRows.innerHTML = "";
    ui.txChannel.innerHTML = "";
    syncStartStopButtons();
    setStateText("Disconnected", "");
    syncConnectButton();
    resetDeviceChips();
    hideModals();
  }

  async function disconnectAll() {
    for (const t of state.txTasks) stopTaskTimer(t);
    if (state.rxRenderTimer !== null) {
      clearTimeout(state.rxRenderTimer);
      state.rxRenderTimer = null;
    }
    if (state.txRenderTimer !== null) {
      clearTimeout(state.txRenderTimer);
      state.txRenderTimer = null;
    }
    if (state.adapter) {
      try {
        await state.adapter.stopReceive();
      } catch (_) {}
      try {
        await state.adapter.disconnect();
      } catch (_) {}
    }
    state.adapter = null;
    state.connected = false;
    state.busReady = false;
    state.startedChannels = [];
    state.busReady = false;
    ui.channelRows.innerHTML = "";
    ui.txChannel.innerHTML = "";
    syncStartStopButtons();
    setStateText("Disconnected", "");
    syncConnectButton();
    resetDeviceChips();
  }

  /* Stop the bus: everything the toolbar/panel Start set up. */
  async function doStopBus() {
    if (!state.adapter || !state.connected) return;

    const channels = state.startedChannels.slice();
    try {
      for (const ch of channels) {
        await state.adapter.resetBus(ch);
      }
      state.startedChannels = [];
      state.busReady = false;
      state.runningConfig = {};
      for (const t of state.txTasks) stopTaskTimer(t);
      populateTxChannelSelect([]);
      setStateText(channels.length ? `Stopped (${channels.map(channelLabel).join(", ")})` : "Stopped", "");
    } catch (err) {
      console.error(err);
      setStateText(`Stop failed: ${err?.message || err}`, "danger");
    } finally {
      renderTxTasks();
      renderChannelRows();
      renderTimingSummary();
      syncStartStopButtons();
      updateDeviceChips();
      syncConnectButton();
    }
  }

  function toggleBus() {
    return state.startedChannels.length ? doStopBus() : doStartBus();
  }

  /*
   * RST: re-initialise the bus (stop -> start on every started channel), the
   * same way for every adapter.  That is what a controller reset means on the
   * wire: error counters cleared, bus-off recovered, TX/RX FIFOs flushed - and
   * the bus stays usable afterwards, unlike stopping it.
   *
   * AUTO tasks are only paused across the reset and resume afterwards (a bus
   * reset must not silently turn periodic sending off).  Nothing is started:
   * RST then opens the bus configuration instead of doing nothing.
   */
  async function resetBus() {
    if (!state.adapter || !state.connected) return;

    if (state.startedChannels.length === 0) {
      setStateText("Configure bus…", "");
      showModal("connect");
      return;
    }

    const channels = state.startedChannels.slice();
    const wasRunning = state.txTasks.filter((t) => !!t.timer);
    for (const t of state.txTasks) stopTaskTimer(t);

    try {
      for (const ch of channels) {
        await state.adapter.resetBus(ch);
        await state.adapter.initBus(buildBusConfig(ch, state.lastBusConfig));
        const snap = state.lastBusConfig;
        state.runningConfig[ch] = configKey({
          timing: snap.perChannel[ch].timing,
          termination: snap.perChannel[ch].termination,
          fdMode: snap.fdMode,
          listenOnly: snap.listenOnly
        });
      }
      state.busReady = true;
      populateTxChannelSelect(channels);
      setStateText(`Bus reset (${channels.map(channelLabel).join(", ")})`, "ok");
    } catch (err) {
      console.error(err);
      state.startedChannels = [];
      state.busReady = false;
      populateTxChannelSelect([]);
      setStateText(`Reset failed: ${err?.message || err}`, "danger");
    } finally {
      for (const t of wasRunning) {
        startTaskTimer(t);
      }
      renderTxTasks();
      renderChannelRows();
      syncStartStopButtons();
      updateDeviceChips();
      syncConnectButton();
    }
  }

  function updateTxModalDeps() {
    const rtr = !!ui.txRtr.checked;
    const fd = !!ui.txFd.checked;
    /* RTR → no data */
    document.getElementById("lenField").style.opacity = rtr ? "0.4" : "";
    ui.txLen.disabled = rtr;
    document.getElementById("dataField").style.opacity = rtr ? "0.4" : "";
    for (let i = 0; i < TX_BYTE_BOXES; i++) {
      const box = byteBox(i);
      if (box) {
        box.disabled = rtr;
      }
    }
    ui.btnMoreData.disabled = rtr;
    /* BRS only if FD */
    ui.txBrs.disabled = !fd;
    if (!fd) ui.txBrs.checked = false;
    /* Refresh length dropdown, preserving current selection if valid */
    const prevLen = ui.txLen.value;
    fillTxLenOptions(fd);
    /* Keep the previous length when the new list still offers it, otherwise
     * fall back to 8 instead of leaving the select empty. */
    if (Array.from(ui.txLen.options).some(o => o.value === prevLen)) {
      ui.txLen.value = prevLen;
    } else {
      ui.txLen.value = "8";
    }
    updateTxByteBoxDims();
  }

  /* --- Context menu --- */
  const ctxMenu = document.getElementById("ctxMenu");

  function showCtxMenu(x, y) {
    ctxMenu.style.left = x + "px";
    ctxMenu.style.top = y + "px";
    ctxMenu.style.display = "";
  }

  function hideCtxMenu() {
    ctxMenu.style.display = "none";
  }

  document.addEventListener("click", hideCtxMenu);

  /* Right-click on TX table → context menu */
  /* Right-click selects the row it points at and offers Add / Edit / Delete. */
  function updateCtxMenu() {
    const has = !!txTaskById(state.txSelectedId);
    for (const el of ctxMenu.querySelectorAll('[data-ctx="edit-tx"], [data-ctx="del-tx"]')) {
      el.style.opacity = has ? "" : "0.4";
      el.style.pointerEvents = has ? "" : "none";
    }
  }

  document.querySelector(".pane:nth-child(2) .pane-body").addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    const row = ev.target && ev.target.closest ? ev.target.closest("tr[data-task-id]") : null;
    if (row) {
      selectTxTask(Number(row.dataset.taskId));
    }
    updateCtxMenu();
    showCtxMenu(ev.clientX, ev.clientY);
  });

  ctxMenu.addEventListener("click", (ev) => {
    const act = ev.target.dataset.ctx;
    if (!act) {
      return;
    }
    hideCtxMenu();

    if (act === "new-tx") {
      openTxModalForNew();
      return;
    }
    const task = txTaskById(state.txSelectedId);
    if (!task) {
      return;
    }
    if (act === "edit-tx") {
      openTxModalForEdit(task);
    } else if (act === "del-tx") {
      deleteTxTask(task.id);
    }
  });

  /*
   * Keyboard shortcuts for the TX list (ignored while typing in a control or
   * while a panel is open):  arrow up/down select, right sends once, left
   * toggles AUTO, Enter edits, Delete removes, Ctrl+C / Ctrl+V copy / paste.
   */
  document.addEventListener("keydown", (ev) => {
    const t = ev.target;
    const typing = t && (t.tagName === "INPUT" || t.tagName === "SELECT"
      || t.tagName === "TEXTAREA" || t.isContentEditable);
    if (typing || ui.modalBackdrop.classList.contains("show")) {
      return;
    }

    const tasks = state.txTasks;
    const index = tasks.findIndex((task) => task.id === state.txSelectedId);
    const current = index >= 0 ? tasks[index] : null;

    const move = (delta) => {
      if (tasks.length === 0) {
        return;
      }
      const next = index < 0
        ? (delta > 0 ? 0 : tasks.length - 1)
        : Math.max(0, Math.min(tasks.length - 1, index + delta));
      selectTxTask(tasks[next].id);
      ev.preventDefault();
    };

    const key = ev.key;
    if ((ev.ctrlKey || ev.metaKey) && key && key.toLowerCase() === "c") {
      if (copySelectedTxTask()) {
        ev.preventDefault();
      }
      return;
    }
    if ((ev.ctrlKey || ev.metaKey) && key && key.toLowerCase() === "v") {
      pasteTxTask().catch(() => {});
      ev.preventDefault();
      return;
    }
    if (ev.ctrlKey || ev.metaKey || ev.altKey) {
      return;
    }

    switch (key) {
    case "ArrowDown":
      move(1);
      return;
    case "ArrowUp":
      move(-1);
      return;
    case "ArrowRight":
      if (current) {
        sendTask(current).catch(() => {});
        ev.preventDefault();
      }
      return;
    case "ArrowLeft":
      if (current) {
        if (current.period > 0) {
          if (current.timer) {
            stopTaskTimer(current);
          } else {
            startTaskTimer(current);
          }
          renderTxTasks();
        } else {
          setStateText("No cycle period on this message — press Enter to edit it", "danger");
        }
        ev.preventDefault();
      }
      return;
    case "Enter":
      if (current) {
        openTxModalForEdit(current);
        ev.preventDefault();
      }
      return;
    case "Delete":
    case "Backspace":
      if (current) {
        deleteTxTask(current.id);
        ev.preventDefault();
      }
      return;
    case "Escape":
      if (state.txSelectedId !== null) {
        state.txSelectedId = null;
        paintTxSelection();
      }
      return;
    default:
      return;
    }
  });

  function bindEvents() {
    buildTxByteBoxes();
    /* typing a new ID should replace the old one, not append to it */
    ui.txId.addEventListener("focus", () => ui.txId.select());
    ui.txLen.addEventListener("change", updateTxByteBoxDims);
    ui.txFd.addEventListener("change", updateTxModalDeps);
    ui.txRtr.addEventListener("change", updateTxModalDeps);

    /* Track button presses inside the TX table so repaints can be deferred
     * (see txPointerHeld()). */
    ui.txTaskBody.addEventListener("pointerdown", () => { txPointerDownAt = Date.now(); });

    /*
     * Double-click a TX row to send it once.  The table is repainted whenever a
     * frame count changes, so a repaint between the two clicks would eat the
     * browser's dblclick event; this watches presses instead and identifies the
     * row by its task id, which survives the repaint.
     */
    let lastTxPress = { id: null, at: 0 };
    ui.txTaskBody.addEventListener("pointerdown", (ev) => {
      const target = ev.target;
      const tr = target && target.closest ? target.closest("tr[data-task-id]") : null;
      if (!tr || (target.closest && target.closest("button"))) {
        return;                                   /* buttons act on their own */
      }
      if (target.closest && target.closest("input, select, textarea")) {
        /* editing a cell in place: never mistake that for a row double-click */
        lastTxPress = { id: null, at: 0 };
        return;
      }

      const id = Number(tr.dataset.taskId);
      const now = Date.now();
      selectTxTask(id);
      if (lastTxPress.id === id && (now - lastTxPress.at) <= 400) {
        lastTxPress = { id: null, at: 0 };
        const task = state.txTasks.find((t) => t.id === id);
        if (task) {
          sendTask(task).catch(() => {});
        }
        return;
      }
      lastTxPress = { id, at: now };
    });
    window.addEventListener("pointerup", () => { txPointerDownAt = 0; });
    window.addEventListener("pointercancel", () => { txPointerDownAt = 0; });
    window.addEventListener("blur", () => { txPointerDownAt = 0; });
    /* Device panel: without a device it runs the picker, with one it just
     * re-opens the panel (channels, timing, termination). */
    ui.btnDevice.addEventListener("click", () => {
      if (state.connected) {
        openDevicePanel();
      } else {
        doConnect().catch(() => {});
      }
    });

    ui.btnStartStop.addEventListener("click", () => { toggleBus().catch(() => {}); });

    ui.btnCloseConnectModal.addEventListener("click", hideModals);
    ui.btnStartBus.addEventListener("click", () => { toggleBus().catch(() => {}); });
    ui.btnApplyAllTiming.addEventListener("click", applyPresetToAllChannels);
    ui.btnApplyPending.addEventListener("click", () => { applyPendingConfig().catch(() => {}); });

    ui.btnCloseTimingModal.addEventListener("click", discardTimingDraft);
    ui.btnTimingCancel.addEventListener("click", discardTimingDraft);
    ui.btnTimingOk.addEventListener("click", acceptTimingDialog);

    /* the candidate list follows the inputs - pick a row, no Generate button */
    for (const el of [ui.nomBitrate, ui.nomSample]) {
      el.addEventListener("input", refreshNominal);
    }
    for (const el of [ui.dataBitrate, ui.dataSample]) {
      el.addEventListener("input", refreshData);
    }

    ui.preset.addEventListener("change", () => {
      /* the panel select is "apply to all" - it also updates the summary */
      renderTimingSummary();
    });
    ui.forceClassic.addEventListener("change", () => {
      renderTimingSummary();
      renderPresetOptions(ui.preset, ui.preset.value);
      renderChannelRows();
      if (state.timingDraft) {
        renderTimingResults();
      }
    });
    ui.btnDisconnectDevice.addEventListener("click", () => { doDisconnectFromModal().catch(() => {}); });

    ui.btnReset.addEventListener("click", () => { resetBus().catch(() => {}); });

    /* The state chip leads back to the bus configuration (change preset, add or
     * remove channels) - same entry point for every adapter. */
    ui.chipState.addEventListener("click", () => {
      if (!state.connected) return;
      setStateText("Configure bus…", "");
      showModal("connect");
    });
    ui.btnClearRx.addEventListener("click", clearCounters);

    ui.btnDebug.addEventListener("click", () => setDebugMode(!state.debugOn));
    ui.btnDebugClear.addEventListener("click", () => {
      state.debugLog = [];
      state.debugSeq = 0;
      renderDebugLog();
    });
    ui.debugFrames.addEventListener("change", () => {
      setDebugFrames(ui.debugFrames.checked);
    });

    ui.btnOpenTxModal.addEventListener("click", openTxModalForNew);
    ui.btnCloseTxModal.addEventListener("click", hideModals);
    ui.btnTxCancel.addEventListener("click", hideModals);
    ui.btnTxAdd.addEventListener("click", saveTxTaskAndAddAnother);

    /* editing the form again makes it worth saving */
    for (const evName of ["input", "change"]) {
      ui.txModal.addEventListener(evName, () => { state.txFormAlreadyAdded = false; });
    }
    ui.btnTxDone.addEventListener("click", saveTxTask);

    ui.btnMoreData.addEventListener("click", openDataModal);
    ui.txDataLen.addEventListener("change", () => {
      const typed = readByteBoxes("full-byte", 64);
      rebuildFullDataBoxes(typed);
    });
    /* a new cycle value should replace the old one, like the message ID */
    ui.txPeriod.addEventListener("focus", () => ui.txPeriod.select());
    window.addEventListener("resize", relayoutByteBoxes);
    ui.btnCloseDataModal.addEventListener("click", () => showModal("tx"));
    ui.btnCancelDataModal.addEventListener("click", () => showModal("tx"));
    ui.btnApplyDataModal.addEventListener("click", applyDataModal);

    ui.modalBackdrop.addEventListener("click", () => {
      if (ui.timingModal.classList.contains("show")) {
        discardTimingDraft();
      } else {
        hideModals();
      }
    });

    ui.txTaskBody.addEventListener("click", (ev) => {
      const btn = ev.target.closest("button[data-act]");
      if (!btn) return;
      const id = Number(btn.dataset.id || 0);
      const act = btn.dataset.act;
      const task = state.txTasks.find((t) => t.id === id);
      if (!task) return;

      if (act === "send") {
        /* Manual single-shot */
        sendTask(task).catch(() => {});
        return;
      }
      if (act === "auto") {
        /* Toggle periodic send */
        if (task.timer) {
          stopTaskTimer(task);
        } else {
          startTaskTimer(task);
        }
        renderTxTasks();
        return;
      }
      if (act === "edit") {
        openTxModalForEdit(task);
        return;
      }
      if (act === "del") {
        deleteTxTask(task.id);
      }
    });
  }

  function init() {
    initTheme();
    const hasProtocols = loadProtocols();
    fillTxLenOptions(false);
    setStateText(hasProtocols ? "Disconnected" : "No protocol", hasProtocols ? "" : "danger");
    syncConnectButton();
    syncStartStopButtons();
    resetDeviceChips();
    renderRxSummary();
    renderTxTasks();
    bindEvents();
  }

  init();
})();
