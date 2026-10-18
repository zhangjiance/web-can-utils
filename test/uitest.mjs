/**
 * End-to-end UI check for the app (jsdom + fake WebUSB gs_usb device).
 *
 * Run:  npm install && npm test
 *
 * Drives the real index.html/app.js: add device -> per-channel ticks
 * (start / termination) -> Start -> TX/AUTO -> bit-timing table + manual entry
 * -> Stop, and reports what the adapter actually did on the wire.
 */
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const CAN = process.env.CAN_DIR || new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const GS_REQ = {
    HOST_FORMAT: 0, BIT_TIMING: 1, MODE: 2, BT_CONST: 4, DEVICE_CONFIG: 5,
    BIT_TIMING_FD: 10, BT_CONST_EXT: 11, TERMINATION: 12, LAST_ERROR: 22,
    RESISTER_STATE: 15, RESISTER_SET: 16, INTERFACE_ENDPOINT: 17,
};
const FEATURE = 0x0001 | 0x0002 | 0x0010 | 0x0080 | 0x0100 | 0x0400 | 0x0800; // LISTEN_ONLY|LOOP_BACK|HW_TS|PAD|FD|BT_CONST_EXT|TERMINATION

class FakeUsbDevice {
    constructor(icount) {
        this.vendorId = 0x1d50;
        this.productId = 0x606f;
        this.serialNumber = "TEST-0001";
        this.opened = false;
        this.icount = icount;
        this.feature = FEATURE;
        this.ctrl = [];
        this.out = [];
        this.inCalls = 0;
        this.rxQueue = [];
        this.claimed = [];
        this.termination = false;      /* what the vendor request 15 reports */
        this._config = {
            interfaces: [{
                interfaceNumber: 0,
                alternates: [{
                    interfaceClass: 0xff,
                    endpoints: [
                        { direction: "in", type: "bulk", endpointNumber: 0x81, packetSize: 64 },
                        { direction: "out", type: "bulk", endpointNumber: 0x02, packetSize: 64 },
                    ],
                }],
            }],
        };
    }

    get configuration() { return this._config; }
    async open() { this.opened = true; }
    async close() { this.opened = false; }
    async claimInterface(n) { this.claimed.push(n); }
    async releaseInterface(n) { this.claimed = this.claimed.filter((c) => c !== n); }

    _u32(dv, off, v) { dv.setUint32(off, v >>> 0, true); }

    async controlTransferIn(setup) {
        this.ctrl.push({ request: setup.request, value: setup.value, index: setup.index });
        if (setup.request === GS_REQ.DEVICE_CONFIG) {
            const b = new Uint8Array(12); const dv = new DataView(b.buffer);
            dv.setUint8(3, this.icount);
            this._u32(dv, 4, 0x00010008); this._u32(dv, 8, 0x01010000);
            return { status: "ok", data: new DataView(b.buffer) };
        }
        if (setup.request === GS_REQ.BT_CONST || setup.request === GS_REQ.BT_CONST_EXT) {
            const len = setup.request === GS_REQ.BT_CONST ? 40 : 72;
            const b = new Uint8Array(len); const dv = new DataView(b.buffer);
            const lim = [2, 256, 2, 128, 128, 1, 512, 1];
            this._u32(dv, 0, this.feature); this._u32(dv, 4, 80000000);
            lim.forEach((v, i) => this._u32(dv, 8 + 4 * i, v));
            if (len === 72) {
                const dlim = [1, 32, 2, 16, 16, 1, 32, 1];
                dlim.forEach((v, i) => this._u32(dv, 40 + 4 * i, v));
            }
            return { status: "ok", data: new DataView(b.buffer) };
        }
        if (setup.request === GS_REQ.LAST_ERROR) {
            return { status: "ok", data: new DataView(new Uint8Array([2]).buffer) };
        }
        if (setup.request === GS_REQ.RESISTER_STATE) {
            return { status: "ok", data: new DataView(new Uint8Array([this.termination ? 1 : 0]).buffer) };
        }
        return { status: "stall", data: null };
    }

    async controlTransferOut(setup, data) {
        this.ctrl.push({
            request: setup.request, value: setup.value, index: setup.index,
            data: data ? Uint8Array.from(data) : null,
        });
        const bytes = data ? Uint8Array.from(data) : null;
        if (setup.request === GS_REQ.TERMINATION && bytes && bytes.byteLength >= 4) {
            this.termination = new DataView(bytes.buffer).getUint32(0, true) !== 0;
        }
        if (setup.request === GS_REQ.RESISTER_SET && bytes && bytes.byteLength >= 1) {
            this.termination = bytes[0] !== 0;
        }
        return { status: "ok" };
    }

    async transferOut(ep, data) {
        this.out.push({ ep, bytes: Uint8Array.from(data) });
        return { status: "ok" };
    }

    async transferIn() {
        this.inCalls++;
        await new Promise((r) => setTimeout(r, 5));
        if (this.rxQueue.length) {
            const bytes = this.rxQueue.shift();
            return { status: "ok", data: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
        }
        return { status: "ok", data: new DataView(new Uint8Array(0).buffer) };
    }

    queueRx(bytes) { this.rxQueue.push(Uint8Array.from(bytes)); }
}

function rxFrame(channel, id, data) {
    const b = new Uint8Array(24);
    const dv = new DataView(b.buffer);
    dv.setUint32(0, 0xffffffff, true);
    dv.setUint32(4, id >>> 0, true);
    dv.setUint8(8, data.length);
    dv.setUint8(9, channel);
    data.forEach((v, i) => dv.setUint8(12 + i, v));
    dv.setUint32(20, 4242, true);
    return b;
}

const device = new FakeUsbDevice(3);            /* icount 3 -> 4 channels */
const dom = new JSDOM(readFileSync(`${CAN}/index.html`, "utf8"),
    { url: "http://localhost/web-can-utils/", pretendToBeVisual: true });
const { window } = dom;

globalThis.window = window;
globalThis.document = window.document;
globalThis.localStorage = window.localStorage;
globalThis.HTMLElement = window.HTMLElement;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.Event = window.Event;
Object.defineProperty(globalThis, "navigator", {
    value: { usb: { requestDevice: async () => device } },
    configurable: true,
});

process.on("unhandledRejection", (e) => console.log("   [unhandled]", e?.message || e));

/* The highlight is one Web Animations call per changed value; jsdom has no
 * Element.animate, so record the calls - that is how the tests below see which
 * values were flashed. */
const flashes = [];
window.Element.prototype.animate = function (keyframes, options) {
    flashes.push({ el: this, keyframes, duration: options && options.duration });
    return { cancel() {}, finish() {}, finished: Promise.resolve() };
};

await import(`${CAN}/app.js`);

const $ = (id) => window.document.getElementById(id);
const click = (id) => $(id).click();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stateText = () => $("chipState").textContent;
const setCheckbox = (cb, checked) => {
    cb.checked = checked;
    cb.dispatchEvent(new window.Event("change", { bubbles: true }));
};
const channelBoxes = (kind) => Array.from(window.document.querySelectorAll(`#channelRows input[data-kind="${kind}"]`));
/* the quick-edit columns hold inputs/selects, so read the editor value there */
const txTable = () => Array.from(window.document.querySelectorAll("#txTaskBody tr"))
    .map((tr) => Array.from(tr.children).map((td) => {
        const editor = td.querySelector("input, select");
        return (editor ? editor.value : td.textContent).trim();
    }));
function rowOf(i) { return window.document.querySelectorAll("#txTaskBody tr")[i]; }
function autoInRow(i) { return rowOf(i)?.querySelector('button[data-act="auto"]'); }
const autoInRowIdxOf = (tr) => tr.querySelector('button[data-act="auto"]');

let failures = 0;
const check = (name, cond, extra = "") => {
    console.log(`  ${cond ? "ok  " : "FAIL"} ${name} ${cond ? "" : extra}`);
    if (!cond) failures++;
};
async function waitFor(what, fn, ms = 2000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        if (fn()) return true;
        await sleep(10);
    }
    console.log(`   !! timed out waiting for ${what}`);
    return false;
}
const bitTiming = () => device.ctrl.filter((c) => c.request === GS_REQ.BIT_TIMING && c.data).pop();
const timingOf = (c) => {
    const dv = new DataView(c.data.buffer);
    return { seg1: dv.getUint32(4, true), seg2: dv.getUint32(8, true), sjw: dv.getUint32(12, true), brp: dv.getUint32(16, true) };
};

console.log("== add device ==");
click("btnDevice");
await waitFor("device panel", () => $("connectModal").classList.contains("show"));
const devLine = $("deviceInfoPlaceholder").textContent;
console.log("   ", devLine);
check("device line shows capability summary", /FD \u2713/.test(devLine) && /Termination \u2713/.test(devLine), devLine);
check("device line shows the loopback capability", /Loop-Back \u2713/.test(devLine), devLine);
check("termination column shown", $("thTerm").style.display !== "none", $("thTerm").style.display);
check("listen / loop / classic columns shown",
    $("thListen").style.display !== "none" && $("thLoop").style.display !== "none"
    && $("thClassic").style.display !== "none",
    `${$("thListen").style.display} / ${$("thLoop").style.display} / ${$("thClassic").style.display}`);
const headerIds = ["thCH", "thStart", "thTerm", "thListen", "thLoop", "thClassic", "thTiming", "thState"];
const headerText = {
    thCH: "CH", thStart: "S", thTerm: "T", thListen: "LS",
    thLoop: "LB", thClassic: "C", thTiming: "Timing", thState: "State"
};
check("headers use the short text labels",
    headerIds.every((id) => $(id).textContent.trim() === headerText[id]),
    headerIds.map((id) => $(id).textContent.trim()).join(" / "));
check("headers keep accessible labels and tooltips",
    headerIds.every((id) => {
        const el = $(id);
        return !!el && !!el.getAttribute("aria-label") && !!el.title;
    }),
    headerIds.map((id) => $(id).getAttribute("aria-label")).join(" / "));
check("left half has six equal columns, right half has Timing + State",
    window.document.querySelectorAll("#connectModal thead th.half-a").length === 6
    && window.document.querySelectorAll("#connectModal thead th.half-b").length === 2);
check("flag tooltips stay short",
    ["listen", "loop", "classic"].every((kind) =>
        channelBoxes(kind).every((cb) => cb.title.length <= 40)),
    JSON.stringify(["listen", "loop", "classic"].map((kind) => channelBoxes(kind)[0]?.title)));
check("legend has six entries plus the combination line",
    window.document.querySelectorAll(".channel-legend > span").length === 7
    && !!window.document.querySelector(".channel-legend .legend-note"));
check("4 start ticks + 4 termination ticks",
    channelBoxes("start").length === 4 && channelBoxes("term").length === 4);
check("per-channel mode ticks (listen / loop / classic)",
    channelBoxes("listen").length === 4 && channelBoxes("loop").length === 4
    && channelBoxes("classic").length === 4,
    `${channelBoxes("listen").length} / ${channelBoxes("loop").length} / ${channelBoxes("classic").length}`);
check("clock line shows the fixed device clock", /80\.000 MHz/.test($("clockInfo").textContent), $("clockInfo").textContent);

console.log("== termination is enabled by default ==");
check("the panel shows what the device reported for its terminators",
    channelBoxes("term").every((cb) => /device: off/.test(cb.title)),
    channelBoxes("term")[0].title);
const starts = channelBoxes("start");
setCheckbox(starts[0], false);
setCheckbox(starts[3], false);
setCheckbox(channelBoxes("term")[1], true);
setCheckbox(channelBoxes("term")[2], true);
click("btnStartBus");
await waitFor("bus up", () => /Connected/.test(stateText()));
check("state lists the started channels", /Connected CH2, CH3/.test(stateText()), stateText());

const termReqs = () => device.ctrl.filter((c) => c.request === GS_REQ.TERMINATION);
check("termination written per started channel (CH2 + CH3)",
    JSON.stringify(termReqs().map((c) => c.value)) === "[1,2]", JSON.stringify(termReqs().map((c) => c.value)));
check("the request switches it on", termReqs().every((c) => c.data && c.data[0] === 1),
    JSON.stringify(termReqs().map((c) => [...c.data])));

/* switching one off must be programmable too */
setCheckbox(channelBoxes("term")[2], false);
await sleep(20);
check("CH3 pending after its termination change", /pending/.test(rowText(2)), rowText(2));
device.ctrl.length = 0;
click("btnApplyPending");
await waitFor("termination applied", () => /Applied/.test(stateText()));
const termOff = device.ctrl.filter((c) => c.request === GS_REQ.TERMINATION && c.value === 2);
check("termination off is written for CH3",
    termOff.length === 1 && termOff[0].data && termOff[0].data[0] === 0,
    JSON.stringify(termOff.map((c) => c.data && [...c.data])));

console.log("== toolbar Start/Stop reflects the state ==");
check("toolbar button shows Stop", /Stop/.test($("btnStartStop").textContent), $("btnStartStop").textContent);

console.log("== TX on CH2 ==");
click("btnOpenTxModal");
await waitFor("tx modal", () => $("txModal").classList.contains("show"));
check("TX channel list == started channels", JSON.stringify(Array.from($("txChannel").options).map((o) => o.value)) === "[\"1\",\"2\"]",
    Array.from($("txChannel").options).map((o) => o.value).join(","));
$("txId").value = "123";
["11", "22", "33", "44"].forEach((hex, i) => setField($(`data-byte-${i}`), hex));
click("btnTxDone");
await sleep(30);
check("TX task added", txTable().length === 1, JSON.stringify(txTable()));
window.document.querySelector('#txTaskBody button[data-act="send"]').click();
await waitFor("frame out", () => device.out.length > 0, 1000);
const tx = device.out[device.out.length - 1];
check("frame reached the device on CH2", !!tx && tx.ep === 0x02 && tx.bytes[9] === 1, JSON.stringify(tx && [tx.ep, tx.bytes[9]]));
await sleep(150);
check("count incremented", txTable()[0][6] === "1", JSON.stringify(txTable()[0]));


function fireInput(el) { return el.dispatchEvent(new window.Event("input", { bubbles: true })); }
function setField(el, value) { el.value = value; fireInput(el); }
function setSelect(el, value) {
    el.value = value;
    el.dispatchEvent(new window.Event("change", { bubbles: true }));
}
const timingBtnFor = (ch) => window.document.querySelector(`#channelRows button[data-timing="${ch}"]`);
function rowSelect(i) { return window.document.querySelectorAll("#channelRows select[data-timing-preset]")[i]; }
function rowText(i) { return window.document.querySelectorAll("#channelRows tr")[i].textContent.replace(/\s+/g, " "); }

console.log("== double-click a TX row sends it once ==");
function txRowFor() { return window.document.querySelector("#txTaskBody tr[data-task-id]"); }
function pressTxRow(tr, target) {
    (target || tr).dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
    window.dispatchEvent(new window.Event("pointerup", { bubbles: true }));   /* a real click releases */
}
const outBeforeDbl = device.out.length;
const row123 = txRowFor();
const countBeforeDbl = Number(txTable()[0][6]);
pressTxRow(row123);
await sleep(40);
check("one press sends nothing yet", device.out.length === outBeforeDbl, `out=${device.out.length}`);
pressTxRow(row123);
await waitFor("double-click sent a frame", () => device.out.length > outBeforeDbl, 1000);
check("double-click sent exactly one frame", device.out.length === outBeforeDbl + 1, `out=${device.out.length}`);
await sleep(220);
check("count incremented by the double-click send",
    Number(txTable()[0][6]) === countBeforeDbl + 1, `${countBeforeDbl} -> ${txTable()[0][6]}`);

const outSlow = device.out.length;
pressTxRow(row123);
await sleep(600);                                   /* too slow for a double click */
pressTxRow(row123);
await sleep(60);
check("two slow presses do not send", device.out.length === outSlow, `out=${device.out.length}`);

const outBtn = device.out.length;
txRowFor().querySelector('button[data-act="send"]').click();
await sleep(40);
txRowFor().querySelector('button[data-act="send"]').click();
await sleep(60);
check("the SEND button still sends one frame per click",
    device.out.length === outBtn + 2, `out=${device.out.length} (expected ${outBtn + 2})`);

console.log("== per-byte data entry ==");
click("btnOpenTxModal");
await waitFor("tx modal", () => $("txModal").classList.contains("show"));
const byteBoxes = () => Array.from(window.document.querySelectorAll("#txByteBoxes input"));
check("8 indexed byte boxes", byteBoxes().length === 8
    && byteBoxes().map((b) => b.previousSibling.textContent).join("") === "01234567",
    `${byteBoxes().length} / ${byteBoxes().map((b) => b.previousSibling.textContent).join("")}`);
check("boxes carry the default 55 pattern", byteBoxes().every((b) => b.value === "55"),
    byteBoxes().map((b) => b.value).join(" "));

byteBoxes()[0].focus();
setField(byteBoxes()[0], "DE");
await sleep(20);
check("two hex digits jump to the next byte", window.document.activeElement === byteBoxes()[1],
    window.document.activeElement ? window.document.activeElement.id : "none");
setField(byteBoxes()[1], "AD");
await sleep(20);
check("the next byte is where typing continues", byteBoxes()[1].value === "AD", byteBoxes()[1].value);

/* the MSG ID selects itself when focused, so a new ID just overwrites */
$("txId").value = "7AB";
$("txId").dispatchEvent(new window.Event("focus"));
$("txPeriod").value = "250";
$("txPeriod").dispatchEvent(new window.Event("focus"));
check("focusing the cycle field selects it",
    $("txPeriod").selectionStart === 0 && $("txPeriod").selectionEnd === $("txPeriod").value.length,
    `${$("txPeriod").selectionStart}-${$("txPeriod").selectionEnd}`);
check("focusing the MSG ID selects it",
    $("txId").selectionStart === 0 && $("txId").selectionEnd === $("txId").value.length,
    `${$("txId").selectionStart}-${$("txId").selectionEnd}`);

setField($("txId"), "0FF");
click("btnTxDone");
await sleep(30);
check("the entered bytes landed in the message",
    txTable().some((r) => r[1] === "0xFF" && /DE AD/.test(r[4])), JSON.stringify(txTable().slice(-1)));

/* more than 8 bytes still goes through the full editor */
click("btnOpenTxModal");
await waitFor("tx modal again", () => $("txModal").classList.contains("show"));
click("btnMoreData");
await waitFor("full data editor", () => $("txDataModal").classList.contains("show"));
check("the full editor lays the bytes out as a grid", $("txDataBoxes").style.display === "grid",
    $("txDataBoxes").style.display);
check("the full editor uses the same indexed boxes",
    window.document.querySelectorAll("#txDataBoxes input").length === 8
    && window.document.querySelector("#txDataBoxes input").previousSibling.textContent === "0",
    String(window.document.querySelectorAll("#txDataBoxes input").length));
setSelect($("txDataLen"), "12");
await sleep(20);
check("the length select resizes the editor",
    window.document.querySelectorAll("#txDataBoxes input").length === 12,
    String(window.document.querySelectorAll("#txDataBoxes input").length));
/* balanced rows: with room for 5, 12 bytes must become 4/4/4 (not 5/5/2) */
Object.defineProperty($("txDataBoxes"), "clientWidth", { value: 180, configurable: true });
window.dispatchEvent(new window.Event("resize"));
await sleep(20);
check("rows are balanced, not greedy", $("txDataBoxes").dataset.perRow === "4", $("txDataBoxes").dataset.perRow);
check("grid columns follow the balanced count",
    /repeat\(4, auto\)/.test($("txDataBoxes").style.gridTemplateColumns),
    $("txDataBoxes").style.gridTemplateColumns);
["01","02","03","04","05","06","07","08","09","0A","0B","0C"].forEach((hex, i) => setField($(`full-byte-${i}`), hex));
click("btnApplyDataModal");
await sleep(30);
check("full editor keeps the first 8 bytes in the boxes",
    byteBoxes().map((b) => b.value).join(" ") === "01 02 03 04 05 06 07 08",
    byteBoxes().map((b) => b.value).join(" "));
check("length followed the full editor", $("txLen").value === "12", $("txLen").value);
setField($("txId"), "0FE");
click("btnTxDone");
await sleep(30);
check("a 12-byte message was saved",
    txTable().some((r) => r[1] === "0xFE" && r[3] === "12"), JSON.stringify(txTable().slice(-1)));

console.log("== Add / Done / Cancel ==");
click("btnOpenTxModal");
await waitFor("tx modal", () => $("txModal").classList.contains("show"));
check("buttons are named Add / Done / Cancel",
    $("btnTxAdd").textContent.trim() === "Add"
    && $("btnTxDone").textContent.trim() === "Done"
    && $("btnTxCancel").textContent.trim() === "Cancel",
    `${$("btnTxAdd").textContent}/${$("btnTxDone").textContent}/${$("btnTxCancel").textContent}`);
setField($("txId"), "222");
setField($("data-byte-0"), "AA");
click("btnTxAdd");
await sleep(30);
check("Add kept the panel open", $("txModal").classList.contains("show"));
check("the message was saved", txTable().some((r) => r[1] === "0x222"), JSON.stringify(txTable().map((r) => r[1])));
const addedRow = Array.from(window.document.querySelectorAll("#txTaskBody tr[data-task-id]"))
    .find((tr) => tr.querySelector('[data-edit="id"]')?.value === "0x222");
check("a new message starts with a 100 ms cycle",
    addedRow?.querySelector('[data-edit="cycle"]').value === "100",
    addedRow ? addedRow.querySelector('[data-edit="cycle"]').value : "no row");
check("form cleared for the next message", $("txId").value === "0", $("txId").value);
setField($("txId"), "333");
click("btnTxAdd");
await sleep(30);
check("a further message can be added the same way", txTable().some((r) => r[1] === "0x333"), JSON.stringify(txTable().map((r) => r[1])));
check("still open", $("txModal").classList.contains("show"));
const countBeforeCancel = txTable().length;
click("btnTxCancel");
await sleep(20);
check("Cancel closes the panel", !$("txModal").classList.contains("show"));
check("Cancel saved nothing", txTable().length === countBeforeCancel, String(txTable().length));

console.log("== TX list: selection / context menu / keyboard ==");
const key = (k, opts = {}) => window.document.dispatchEvent(
    new window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...opts }));
const txRows = () => Array.from(window.document.querySelectorAll("#txTaskBody tr[data-task-id]"));
const selectedRow = () => window.document.querySelector("#txTaskBody tr.selected");
const rowOfId = (id) => window.document.querySelector(`#txTaskBody tr[data-task-id="${id}"]`);

pressTxRow(txRows()[0]);
await sleep(20);
check("clicking a row selects it", !!selectedRow() && selectedRow() === rowOfId(txRows()[0].dataset.taskId),
    selectedRow() ? selectedRow().dataset.taskId : "none");

key("ArrowDown");
await sleep(20);
check("ArrowDown moves down one", selectedRow() === txRows()[1], selectedRow() ? selectedRow().dataset.taskId : "none");
key("ArrowUp");
await sleep(20);
check("ArrowUp moves back up", selectedRow() === txRows()[0], selectedRow() ? selectedRow().dataset.taskId : "none");

const outBeforeKey = device.out.length;
key("ArrowRight");
await waitFor("ArrowRight sends", () => device.out.length > outBeforeKey, 1000);
check("ArrowRight sends the selected message once", device.out.length === outBeforeKey + 1, `out=${device.out.length}`);

/* the default cycle is 100 ms now, so clear it to get a manual message */
const manualRow = selectedRow();
const cycleEditor = manualRow.querySelector('[data-edit="cycle"]');
cycleEditor.value = "0";
cycleEditor.dispatchEvent(new window.Event("change", { bubbles: true }));
await sleep(30);
check("clearing the cycle makes the message manual",
    autoInRowIdxOf(manualRow).style.display === "none" && cycleEditor.value === "0",
    `${cycleEditor.value} / ${autoInRowIdxOf(manualRow).style.display}`);

key("ArrowLeft");
await sleep(20);
check("ArrowLeft on a manual message explains instead of doing nothing",
    /No cycle period/.test(stateText()), stateText());

/* right-click a different row: it becomes selected and the menu offers Edit/Delete */
txRows()[1].dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 }));
await sleep(20);
check("right-click selects that row", selectedRow() === txRows()[1]);
check("context menu is open", $("ctxMenu").style.display !== "none", $("ctxMenu").style.display);
const ctxItem = (act) => $("ctxMenu").querySelector(`[data-ctx="${act}"]`);
check("Edit / Delete enabled with a row selected",
    ctxItem("edit-tx").style.pointerEvents !== "none" && ctxItem("del-tx").style.pointerEvents !== "none");

ctxItem("edit-tx").click();
await waitFor("edit panel", () => $("txModal").classList.contains("show"));
check("Edit opened the panel for that message", /Edit TX Frame/.test($("txModalTitle").textContent), $("txModalTitle").textContent);
click("btnTxCancel");
await sleep(20);

const countBeforeDelete = txRows().length;
rowOfId(txRows()[1].dataset.taskId).dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true }));
await sleep(20);
ctxItem("del-tx").click();
await sleep(30);
check("Delete removed the row", txRows().length === countBeforeDelete - 1, `${countBeforeDelete} -> ${txRows().length}`);
check("a neighbouring row is selected after the delete", !!selectedRow(), selectedRow() ? selectedRow().dataset.taskId : "none");
check("context menu closed after the action", $("ctxMenu").style.display === "none", $("ctxMenu").style.display);

/* copy / paste */
pressTxRow(txRows()[0]);
await sleep(20);
const countBeforePaste = txRows().length;
key("c", { ctrlKey: true });
await sleep(20);
check("Ctrl+C reports the copy", /Copied/.test(stateText()), stateText());
key("v", { ctrlKey: true });
await waitFor("paste added a row", () => txRows().length === countBeforePaste + 1, 1000);
check("Ctrl+V pasted a new row", txRows().length === countBeforePaste + 1, String(txRows().length));
check("pasted row is the one selected", selectedRow() === txRows()[txRows().length - 1]);

/* the reported bug: Add, Add, Done must add exactly two entries */
const beforeFlow = txTable().length;
click("btnOpenTxModal");
await waitFor("tx modal", () => $("txModal").classList.contains("show"));
setField($("txId"), "401");
click("btnTxAdd");
setField($("txId"), "402");
click("btnTxAdd");
click("btnTxDone");
await sleep(30);
check("Add, Add, Done adds exactly two", txTable().length === beforeFlow + 2, `${beforeFlow} -> ${txTable().length}`);
check("no phantom message from the cleared form",
    !txTable().some((r) => r[1] === "0x11"), JSON.stringify(txTable().map((r) => r[1])));
check("Done closed the panel", !$("txModal").classList.contains("show"));

/* ...and editing the cleared form again still adds one */
click("btnOpenTxModal");
await waitFor("tx modal", () => $("txModal").classList.contains("show"));
setField($("txId"), "404");
click("btnTxDone");
await sleep(30);
check("a filled-in form is still saved by Done", txTable().some((r) => r[1] === "0x404"), JSON.stringify(txTable().map((r) => r[1])));

console.log("== presets carry the resulting sample point ==");
check("preset option tooltip carries the resolved timing", /brp1 tseg1/.test($("preset").options[0].title), $("preset").options[0].title);
check("clock line is terse", /^Clock 80\.000 MHz$/.test($("clockInfo").textContent), $("clockInfo").textContent);
check("clock explanation is a tooltip", /fixed CAN clock/.test($("clockInfo").title), $("clockInfo").title);
check("preset options carry the sample point", /SP \d/.test($("preset").options[0].textContent), $("preset").options[0].textContent);
check("every channel row has a preset picker", !!rowSelect(1) && !!rowSelect(2));

function gear(ch, phase) { return window.document.querySelector(`#channelRows button[data-timing="${ch}"][data-phase="${phase}"]`); }
function rowCells(tr) { return Array.from(tr.children).map((td) => td.textContent.trim()); }
function nomRowsNow() { return Array.from(window.document.querySelectorAll("#nomTable tr")); }
function dataRowsNow() { return Array.from(window.document.querySelectorAll("#dataTable tr")); }

console.log("== per-phase sub-panels (one gear per phase) ==");
check("arbitration gear + data gear (FD is on)", !!gear(1, "nominal") && !!gear(1, "data"));
gear(1, "nominal").click();
await waitFor("timing sub-panel", () => $("timingModal").classList.contains("show"));
check("sub-panel names channel + phase", /CH2 · arbitration/.test($("timingTitle").textContent), $("timingTitle").textContent);
check("no preset select inside the sub-panel", !$("timingPreset"));
check("nothing collapsed in the sub-panel", window.document.querySelectorAll("#timingModal details").length === 0);
check("only bitrate + sample point inputs", !!$("nomBitrate") && !!$("nomSample") && !$("nomBrp"));
check("data section hidden while editing arbitration", $("dataPhase").style.display === "none");
check("no clock selector (the CAN clock is fixed and reported)", !$("clockSelect"));

console.log("== the timing list follows bitrate + sample point ==");
$("nomBitrate").value = "500";
$("nomSample").value = "80";
fireInput($("nomSample"));
await sleep(260);
check("candidate list generated", nomRowsNow().length > 3, `rows=${nomRowsNow().length}`);
const firstCells = rowCells(nomRowsNow()[0]);
check("top row is 500.000k @ 80.0%", /500\.000k/.test(firstCells[4]) && firstCells[6] === "80.0%", JSON.stringify(firstCells));
check("the top row is selected for you", /^custom: 500\.000k @ 80(?:\.0)?%/.test($("nomResult").textContent), $("nomResult").textContent);

/* picking a row *is* the manual parameter choice */
const pickRow = nomRowsNow()[2];
const picked = rowCells(pickRow);
pickRow.click();
await sleep(20);
check("clicking a row selects it",
    new RegExp(`brp${picked[0]} tseg1 ${picked[1]} tseg2 ${picked[2]} sjw${picked[3]}`).test($("nomResult").textContent),
    $("nomResult").textContent);
click("btnTimingOk");
await sleep(30);
check("OK closed the sub-panel", !$("timingModal").classList.contains("show"));
check("back on the device panel (not the main page)", $("connectModal").classList.contains("show"));
check("arbitration gear marked custom", gear(1, "nominal").style.color !== "", gear(1, "nominal").style.color);

console.log("== the data phase has its own sub-panel ==");
gear(1, "data").click();
await waitFor("data sub-panel", () => $("timingModal").classList.contains("show"));
check("sub-panel names the data phase", /CH2 · data/.test($("timingTitle").textContent), $("timingTitle").textContent);
check("arbitration section hidden", $("nominalPhase").style.display === "none");
$("dataBitrate").value = "2000";
$("dataSample").value = "80";
fireInput($("dataSample"));
await sleep(260);
const pickData = rowCells(dataRowsNow()[1]);
dataRowsNow()[1].click();
await sleep(20);
check("data row selected", new RegExp(`tseg1 ${pickData[1]}`).test($("dataResult").textContent), $("dataResult").textContent);
click("btnTimingOk");
await sleep(30);

gear(1, "nominal").click();
await waitFor("arb sub-panel again", () => $("timingModal").classList.contains("show"));
check("editing the data phase left arbitration alone",
    new RegExp(`brp${picked[0]} tseg1 ${picked[1]}`).test($("nomResult").textContent), $("nomResult").textContent);
click("btnTimingCancel");
await sleep(20);

console.log("== pending changes + Apply ==");
check("CH2 row marked pending", /pending/.test(rowText(1)), rowText(1));
check("Apply button enabled", $("btnApplyPending").disabled === false, String($("btnApplyPending").disabled));
check("Apply button stays short, detail in tooltip",
    $("btnApplyPending").textContent.trim() === "⚠ Apply" && /pending settings on CH2/.test($("btnApplyPending").title),
    `${$("btnApplyPending").textContent} / ${$("btnApplyPending").title}`);
device.ctrl.length = 0;
click("btnApplyPending");
/* wait for the actual programming, not just for some "Applied" status text */
await waitFor("CH2 reprogrammed", () => device.ctrl.some((c) => c.request === GS_REQ.BIT_TIMING && c.value === 1 && c.data), 2000);
await sleep(60);
const nomReq = device.ctrl.filter((c) => c.request === GS_REQ.BIT_TIMING && c.value === 1 && c.data).pop();
const dataReq = device.ctrl.filter((c) => c.request === GS_REQ.BIT_TIMING_FD && c.value === 1 && c.data).pop();
check("Apply programmed the picked arbitration timing",
    !!nomReq && timingOf(nomReq).brp === Number(picked[0]) && timingOf(nomReq).seg1 === Number(picked[1]),
    `${JSON.stringify(nomReq && timingOf(nomReq))} vs ${JSON.stringify(picked)}`);
check("Apply programmed the picked data timing",
    !!dataReq && timingOf(dataReq).seg1 === Number(pickData[1]),
    `${JSON.stringify(dataReq && timingOf(dataReq))} vs ${JSON.stringify(pickData)}`);
check("CH2 running again (no pending)", !/pending/.test(rowText(1)), rowText(1));

console.log("== per-channel Classic removes only that channel's data gear ==");
setCheckbox(channelBoxes("classic")[1], true);
await sleep(20);
check("CH2 data gear gone", !gear(1, "data"));
check("CH1 data gear still there", !!gear(0, "data"));
check("CH2 marked pending", /pending/.test(rowText(1)), rowText(1));
setCheckbox(channelBoxes("classic")[1], false);
await sleep(20);
check("CH2 data gear is back", !!gear(1, "data"));

console.log("== per-row preset picker (no sub-panel) ==");
rowSelect(2).value = "1m_4m";
rowSelect(2).dispatchEvent(new window.Event("change", { bubbles: true }));
await sleep(30);
check("CH3 switched preset inline",
    rowSelect(2).value === "1m_4m" && /1M \/ 4M @80%\/80%/.test(rowSelect(2).options[rowSelect(2).selectedIndex].textContent),
    rowSelect(2).options[rowSelect(2).selectedIndex].textContent);
check("CH3 marked pending until applied", /pending/.test(rowText(2)), rowText(2));
check("CH2 kept its custom timings (dropdown still Custom)",
    rowSelect(1).value === "__custom", rowSelect(1).value);

console.log("== restart programs each channel separately ==");
/* Per-channel modes before the restart: CH1 internal loopback, CH2 external
 * loopback, CH3 classic CAN, CH4 untouched FD. */
setCheckbox(channelBoxes("listen")[0], true);
setCheckbox(channelBoxes("loop")[0], true);
setCheckbox(channelBoxes("loop")[1], true);
setCheckbox(channelBoxes("classic")[2], true);
device.ctrl.length = 0;
click("btnStartBus");
await waitFor("stopped", () => /Stopped/.test(stateText()));
click("btnStartBus");
await waitFor("started", () => /Connected/.test(stateText()));
const timingReqs = device.ctrl.filter((c) => c.request === GS_REQ.BIT_TIMING && c.data);
const ch2 = timingReqs.find((c) => c.value === 1);
const ch3 = timingReqs.find((c) => c.value === 2);
check("CH2 kept its custom arbitration timing",
    !!ch2 && timingOf(ch2).brp === Number(picked[0]) && timingOf(ch2).seg1 === Number(picked[1]),
    JSON.stringify(ch2 && timingOf(ch2)));
check("CH3 got the 1M/4M preset (80 % -> brp1 tseg1 63)",
    !!ch3 && timingOf(ch3).brp === 1 && timingOf(ch3).seg1 === 63,
    JSON.stringify(ch3 && timingOf(ch3)));
check("the two channels differ",
    !!ch2 && !!ch3 && JSON.stringify(timingOf(ch2)) !== JSON.stringify(timingOf(ch3)));

const modeReqFor = (ch) => device.ctrl.filter((c) => c.request === GS_REQ.MODE && c.value === ch).pop();
const modeFlagsFor = (ch) => {
    const req = modeReqFor(ch);
    return req ? new DataView(req.data.buffer).getUint32(4, true) : -1;
};
check("CH1 started as internal loopback (LISTEN_ONLY|LOOP_BACK)",
    (modeFlagsFor(0) & 0x3) === 0x3, `0x${(modeFlagsFor(0) >>> 0).toString(16)}`);
check("CH2 started as external loopback (LOOP_BACK only)",
    (modeFlagsFor(1) & 0x3) === 0x2, `0x${(modeFlagsFor(1) >>> 0).toString(16)}`);
check("CH3 started as classic CAN (no FD flag)",
    (modeFlagsFor(2) & 0x100) === 0, `0x${(modeFlagsFor(2) >>> 0).toString(16)}`);
check("CH3 sent no data-phase bittiming",
    !device.ctrl.some((c) => c.request === GS_REQ.BIT_TIMING_FD && c.value === 2));
check("CH4 stayed stopped (its Start tick is still off)",
    modeFlagsFor(3) === -1, `0x${(modeFlagsFor(3) >>> 0).toString(16)}`);

console.log("== apply preset to all ==");
$("preset").value = "500k_2m";
click("btnApplyAllTiming");
await sleep(30);
check("row gear colours cleared (back on presets)",
    gear(1, "nominal").style.color === "" && gear(1, "data").style.color === "",
    `${gear(1, "nominal").style.color} / ${gear(1, "data").style.color}`);
check("dropdown back to a preset value (Custom entry gone)",
    rowSelect(1).value !== "__custom" && !/Custom —/.test(rowSelect(1).textContent),
    `${rowSelect(1).value} / ${rowSelect(1).textContent}`);
check("channels show pending until applied", /pending/.test(rowText(1)), rowText(1));

console.log("== RX + ERR rows, CLR ==");
device.queueRx(rxFrame(1, 0x555, [0xde, 0xad]));
/* the row from the bug report: CTRL+PROT+ACK+BUSERR+CNT, tx-error-passive,
 * protocol bits and location both empty, counters 128/0 */
device.queueRx(rxFrame(1, 0x20000000 | 0x2AC,
    [0x00, 0x20, 0x00, 0x00, 0x00, 0x00, 0x80, 0x00]));
const rxCells = () => Array.from(window.document.querySelectorAll("#rxSummaryBody tr"))
    .map((tr) => Array.from(tr.children).map((td) => td.textContent.trim()));
const errRow = () => Array.from(window.document.querySelectorAll("#rxSummaryBody tr"))
    .find((tr) => tr.children[1] && tr.children[1].textContent.trim() === "ERR");
await waitFor("rx rows", () => rxCells().length >= 2, 1000);
check("frame row and ERR row both shown",
    rxCells().some((c) => c[1] === "ERR") && rxCells().some((c) => c[1] === "0x555"), JSON.stringify(rxCells()));
check("ERR TYPE uses the short class names",
    !!errRow() && errRow().children[2].textContent.trim() === "CTRL+PROT+ACK+BUSERR+CNT",
    errRow() && errRow().children[2].textContent);
check("ERR detail is labelled and drops the empty protocol group",
    !!errRow() && errRow().children[4].textContent.trim() === "ctrl: tx-error-passive | tx-err: 128 | rx-err: 0",
    errRow() && errRow().children[4].textContent);
const errHint = errRow() && errRow().children[4].title;
check("ERR hover explains the frame in words",
    /Controller problem: tx-error-passive/.test(errHint)
    && /Protocol violation \(no detail\)/.test(errHint)
    && /No acknowledgement on TX/.test(errHint)
    && /Bus error/.test(errHint)
    && /Error counters: TX 128, RX 0/.test(errHint),
    errHint);
click("btnClearRx");
await sleep(30);
check("CLR empties the RX list", rxCells().length === 0, JSON.stringify(rxCells()));
check("CLR zeroes the TX counters", txTable().every((r) => r[6] === "0"), JSON.stringify(txTable()));

console.log("== RX payload changes are highlighted ==");
function rxRowFor(id) {
    const label = "0x" + id.toString(16).toUpperCase();
    return Array.from(window.document.querySelectorAll("#rxSummaryBody tr"))
        .find((tr) => tr.children[1] && tr.children[1].textContent.trim() === label);
}
const cellsOf = (id) => Array.from(rxRowFor(id).children);
const animatedIn = (row) => flashes.filter((f) => row && row.contains(f.el));
const animatedBytes = (id) => animatedIn(rxRowFor(id))
    .map((f) => Array.from(rxRowFor(id).querySelectorAll(".rx-byte")).indexOf(f.el))
    .filter((i) => i >= 0);
const animatedCells = (id) => animatedIn(rxRowFor(id))
    .map((f) => Array.from(rxRowFor(id).children).indexOf(f.el))
    .filter((i) => i >= 0);

flashes.length = 0;
device.queueRx(rxFrame(1, 0x600, [0x01, 0x02, 0x03]));
await waitFor("row 0x600", () => !!rxRowFor(0x600), 1000);
check("a brand new row flashes nothing", animatedIn(rxRowFor(0x600)).length === 0,
    String(animatedIn(rxRowFor(0x600)).length));

flashes.length = 0;
device.queueRx(rxFrame(1, 0x600, [0x01, 0x02, 0x03]));   /* same payload */
await sleep(200);
check("the count cell flashes when the counter updates", animatedCells(0x600).includes(6),
    JSON.stringify(animatedCells(0x600)));
check("an unchanged payload still flashes no byte", animatedBytes(0x600).length === 0,
    JSON.stringify(animatedBytes(0x600)));
check("count really advanced", cellsOf(0x600)[6].textContent.trim() === "2", cellsOf(0x600)[6].textContent);

flashes.length = 0;
device.queueRx(rxFrame(1, 0x600, [0x01, 0x09, 0x03]));
await waitFor("byte flash after a change", () => animatedBytes(0x600).length > 0, 1000);
check("only the byte that changed flashes", JSON.stringify(animatedBytes(0x600)) === "[1]",
    JSON.stringify(animatedBytes(0x600)));
check("the row shows the new payload", /01 09 03/.test(rxRowFor(0x600).textContent),
    rxRowFor(0x600).textContent.replace(/\s+/g, " "));

/* The highlight must stay on the values that changed, never on the whole list.
 * The flash colour is theme-dependent: pin dark here so the colour checks do
 * not depend on the stored/default theme. */
click("themeDark");
await sleep(20);
flashes.length = 0;
device.queueRx(rxFrame(1, 0x601, [0xaa, 0xbb]));         /* a second, idle row */
await waitFor("row 0x601", () => !!rxRowFor(0x601), 1000);
await sleep(250);
flashes.length = 0;
device.queueRx(rxFrame(1, 0x600, [0x01, 0x09, 0x03]));   /* count only */
device.queueRx(rxFrame(1, 0x600, [0x01, 0x10, 0x03]));   /* count + one byte */
await sleep(300);
const touchedRxRows = new Set(flashes.map((f) => f.el.closest("tr")));
check("only the row that changed animates",
    touchedRxRows.size === 1 && touchedRxRows.has(rxRowFor(0x600)),
    `${touchedRxRows.size} row(s)`);
check("the idle row animates nothing",
    flashes.every((f) => !rxRowFor(0x601).contains(f.el)),
    JSON.stringify(flashes.map((f) => f.el.tagName + "." + f.el.className)));

/* the highlight colour is its own knob, not the page accent */
check("a flash uses the dedicated colour, not the page accent",
    flashes.length > 0 && flashes.every((f) => String(f.keyframes[0].color).toLowerCase() === "#ffc978"),
    JSON.stringify(flashes.map((f) => f.keyframes[0].color).slice(0, 3)));
check("the glow follows the same variable",
    flashes.every((f) => /rgba?\(255, ?201, ?120/.test(String(f.keyframes[0].textShadow))),
    String(flashes[0] && flashes[0].keyframes[0].textShadow));
check("the fade ends at whatever the element normally is",
    flashes.every((f) => f.keyframes.length === 2 && f.keyframes[1].color === undefined),
    JSON.stringify(flashes[0] && flashes[0].keyframes));

click("themeLight");
await sleep(20);
flashes.length = 0;
device.queueRx(rxFrame(1, 0x600, [0x01, 0x10, 0x04]));   /* one more change, in light theme */
await sleep(250);
check("switching the theme switches the flash colour",
    flashes.length > 0 && flashes.every((f) => String(f.keyframes[0].color).toLowerCase() === "#e8871e"),
    JSON.stringify(flashes.map((f) => f.keyframes[0].color).slice(0, 3)));
click("themeDark");
await sleep(20);

check("the theme buttons sit in a row, not a column",
    window.getComputedStyle($("theme-switcher")).flexDirection === "row",
    window.getComputedStyle($("theme-switcher")).flexDirection);

console.log("== ESI does not split an RX row ==");
/* same message, ESI set on the second frame (the controller's error state) */
const fdFrame = (id, esi) => {
    const b = rxFrame(1, id, [0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55]);
    new DataView(b.buffer).setUint8(10, (1 << 1) | (1 << 2) | (esi ? (1 << 3) : 0));
    return b;
};
flashes.length = 0;
device.queueRx(fdFrame(0x2, false));
await waitFor("FD row 0x2", () => !!rxRowFor(0x2), 1000);
const typeOf = (id) => rxRowFor(id).children[2].textContent;
const visibleType = (id) => typeOf(id).replace(/\u00a0/g, " ");

check("an FD frame shows up as one row", /0x2/.test(rxRowFor(0x2).textContent), rxRowFor(0x2).textContent);
check("its type has no ESI yet", /^CAN FD BRS STD\s*$/.test(visibleType(0x2)), typeOf(0x2));
const typeWidthNoEsi = typeOf(0x2).length;

flashes.length = 0;
device.queueRx(fdFrame(0x2, true));
await sleep(300);
const fdRows = Array.from(window.document.querySelectorAll("#rxSummaryBody tr"))
    .filter((tr) => /CAN FD BRS/.test(tr.textContent));
check("a frame with ESI joins the same row", fdRows.length === 1, `${fdRows.length} row(s)`);
check("the row now says ESI, at the end of the flags", /^CAN FD BRS STD ESI$/.test(typeOf(0x2)),
    typeOf(0x2));
check("ESI keeps the label the same width",
    typeOf(0x2).length === typeWidthNoEsi, `${typeWidthNoEsi} -> ${typeOf(0x2).length}`);
/* jsdom does not resolve var() in getComputedStyle, so read the declaration:
 * it has to be the same variable the highlight animation colours with. */
const cssRule = (selector) => {
    for (const sheet of Array.from(window.document.styleSheets)) {
        for (const rule of Array.from(sheet.cssRules || [])) {
            if (rule.selectorText === selector) return rule;
        }
    }
    return null;
};
check("the ESI token is coloured like a changed value",
    !!rxRowFor(0x2).querySelector(".esi-flag")
    && cssRule(".esi-flag")?.style.color === "var(--flash)",
    String(cssRule(".esi-flag")?.style.color));
check("the counter followed into that row", cellsOf(0x2)[6].textContent.trim() === "2",
    cellsOf(0x2)[6].textContent);
check("an ESI-only change does not animate the TYPE cell", !animatedCells(0x2).includes(2),
    JSON.stringify(animatedCells(0x2)));
check("only the counter moved", JSON.stringify(animatedCells(0x2)) === "[6]",
    JSON.stringify(animatedCells(0x2)));
check("no stray byte flash came with it", animatedBytes(0x2).length === 0,
    JSON.stringify(animatedBytes(0x2)));

/* and it keeps its width when ESI goes away again */
flashes.length = 0;
device.queueRx(fdFrame(0x2, false));
await sleep(250);
check("dropping ESI keeps the width too",
    typeOf(0x2).length === typeWidthNoEsi && /^CAN FD BRS STD\s*$/.test(visibleType(0x2)), typeOf(0x2));
check("and the coloured flag goes away with it", !rxRowFor(0x2).querySelector(".esi-flag"),
    rxRowFor(0x2).children[2].innerHTML);
check("and that does not animate the TYPE cell either", !animatedCells(0x2).includes(2),
    JSON.stringify(animatedCells(0x2)));

/* the slot follows whatever the flags are, with ESI always last */
const extFdFrame = (esi) => {
    const b = rxFrame(1, 0x80000000 | 0x3, [0x11, 0x22]);
    new DataView(b.buffer).setUint8(10, (1 << 1) | (1 << 2) | (esi ? (1 << 3) : 0));
    return b;
};
device.queueRx(extFdFrame(false));
await waitFor("extended FD row", () => !!rxRowFor(0x3), 1000);
const extWidthNoEsi = typeOf(0x3);
device.queueRx(extFdFrame(true));
await sleep(250);
check("an extended FD frame puts ESI after EXT",
    /^CAN FD BRS EXT ESI$/.test(typeOf(0x3)) && typeOf(0x3).length === extWidthNoEsi.length,
    `${typeOf(0x3)} (${extWidthNoEsi.length} -> ${typeOf(0x3).length})`);

console.log("== RST keeps the bus running ==");
const modBefore = device.ctrl.filter((c) => c.request === GS_REQ.MODE).length;
click("btnReset");
await waitFor("reset done", () => /Bus reset/.test(stateText()));
check("RST re-initialised both channels (3 MODE writes each)",
    device.ctrl.filter((c) => c.request === GS_REQ.MODE).length - modBefore === 6,
    String(device.ctrl.filter((c) => c.request === GS_REQ.MODE).length - modBefore));
check("bus still connected after RST", /Bus reset \(CH2, CH3\)/.test(stateText()), stateText());

console.log("== Stop ==");
click("btnStartStop");
await waitFor("stopped", () => /Stopped/.test(stateText()));
check("toolbar button back to Start", /Start/.test($("btnStartStop").textContent), $("btnStartStop").textContent);
check("no channel row says running after Stop",
    !/running/.test($("channelRows").textContent), $("channelRows").textContent.replace(/\s+/g, " "));
check("send refused while stopped", (() => {
    const before = device.out.length;
    window.document.querySelector('#txTaskBody button[data-act="send"]').click();
    return device.out.length === before;
})(), stateText());

console.log("== disconnect / add device again / send (the reported bug) ==");
click("btnDevice");
await waitFor("device panel", () => $("connectModal").classList.contains("show"));
click("btnDisconnectDevice");
await sleep(60);
check("disconnected", /Disconnected/.test(stateText()), stateText());

/* a device that does not advertise termination must not show the control */
device.feature = FEATURE & ~0x0800;
click("btnDevice");                       /* Add device again */
await waitFor("panel again", () => $("connectModal").classList.contains("show"));
check("device re-added", /channel\(s\)/.test($("deviceInfoPlaceholder").textContent), $("deviceInfoPlaceholder").textContent);
check("termination column hidden without the capability", $("thTerm").style.display === "none", $("thTerm").style.display);
check("no termination checkboxes at all", channelBoxes("term").length === 0, String(channelBoxes("term").length));
device.ctrl.length = 0;                       /* ignore the earlier session */
check("the reconnect itself sends no termination request",
    !device.ctrl.some((c) => c.request === GS_REQ.TERMINATION),
    JSON.stringify(device.ctrl.filter((c) => c.request === GS_REQ.TERMINATION)));
const starts2 = channelBoxes("start");
setCheckbox(starts2[0], false);
setCheckbox(starts2[3], false);
device.ctrl.length = 0;                       /* only look at this start */
click("btnStartBus");
await waitFor("bus up after reconnect", () => /Connected/.test(stateText()));
check("starting without the capability sends no termination request",
    !device.ctrl.some((c) => c.request === GS_REQ.TERMINATION),
    JSON.stringify(device.ctrl.filter((c) => c.request === GS_REQ.TERMINATION)));
device.feature = FEATURE;                      /* put the capability back */

const outBeforeReconnectSend = device.out.length;
window.document.querySelector('#txTaskBody button[data-act="send"]').click();
await waitFor("frame after reconnect", () => device.out.length > outBeforeReconnectSend, 2500);
check("SEND works after disconnect + re-add", device.out.length > outBeforeReconnectSend,
    `out=${device.out.length} state=${stateText()}`);

console.log("== TX rows can be edited inline ==");
const txRowAt = (i) => window.document.querySelectorAll("#txTaskBody tr[data-task-id]")[i];
const editorIn = (i, kind) => txRowAt(i).querySelector(`[data-edit="${kind}"]`);
const commitEditor = (el, value) => {
    el.value = value;
    el.dispatchEvent(new window.Event("change", { bubbles: true }));
};

check("every row has inline editors",
    ["channel", "id", "length", "cycle"].every((k) => !!editorIn(0, k)),
    JSON.stringify(["channel", "id", "length", "cycle"].map((k) => !!editorIn(0, k))));

/* The popup of a select is painted with the select's own colours, so these must
 * be solid: a translucent background left the options unreadable in dark mode. */
const selectStyle = () => window.getComputedStyle(editorIn(0, "channel"));
const darkSelect = selectStyle();
check("the inline selects are solid and readable in the dark theme",
    darkSelect.backgroundColor === "rgb(15, 27, 49)" && darkSelect.color === "rgb(236, 242, 255)"
    && /dark/.test(darkSelect.colorScheme || ""),
    `${darkSelect.backgroundColor} / ${darkSelect.color} / ${darkSelect.colorScheme}`);
check("the panel selects are solid too",
    window.getComputedStyle($("txChannel")).backgroundColor === "rgb(15, 27, 49)",
    window.getComputedStyle($("txChannel")).backgroundColor);
click("themeLight");
await sleep(20);
const lightSelect = selectStyle();
check("and they follow the light theme",
    lightSelect.backgroundColor === "rgb(255, 255, 255)" && lightSelect.color === "rgb(31, 41, 55)"
    && /light/.test(lightSelect.colorScheme || ""),
    `${lightSelect.backgroundColor} / ${lightSelect.color} / ${lightSelect.colorScheme}`);
click("themeDark");
await sleep(20);
check("the ID editor holds the message id", /^0x[0-9A-F]+$/.test(editorIn(0, "id").value), editorIn(0, "id").value);

commitEditor(editorIn(0, "id"), "1ABCDEF");
await sleep(20);
check("an 8-digit ID becomes extended",
    /^0x1ABCDEF$/.test(editorIn(0, "id").value) && /EXT/.test(txRowAt(0).children[2].textContent),
    `${editorIn(0, "id").value} / ${txRowAt(0).children[2].textContent}`);

commitEditor(editorIn(0, "cycle"), "250");
await sleep(20);
check("the cycle is edited inline",
    editorIn(0, "cycle").value === "250"
    && txRowAt(0).querySelector('button[data-act="auto"]').style.display !== "none",
    editorIn(0, "cycle").value);

commitEditor(editorIn(0, "channel"), "2");
await sleep(20);
check("the channel is edited inline", editorIn(0, "channel").value === "2", editorIn(0, "channel").value);

commitEditor(editorIn(0, "length"), "4");
await sleep(20);
check("the length is edited inline and the data follows",
    editorIn(0, "length").value === "4" && /^[0-9A-F ]{11}$/.test(txRowAt(0).children[4].textContent.trim()),
    `${editorIn(0, "length").value} / ${txRowAt(0).children[4].textContent.trim()}`);

/* the edited values are what actually goes out */
device.out.length = 0;
flashes.length = 0;
txRowAt(0).querySelector('button[data-act="send"]').click();
await waitFor("frame after inline edit", () => device.out.length > 0, 1000);
await sleep(200);
const sentTxRows = new Set(flashes.map((f) => f.el.closest("tr")));
check("only the TX row that was sent animates",
    sentTxRows.size === 1 && sentTxRows.has(txRowAt(0)), `${sentTxRows.size} row(s)`);
check("and what animates there is its Count cell",
    flashes.every((f) => f.el === txRowAt(0).children[6]), JSON.stringify(flashes.map((f) => f.keyframes.length)));
const sent = device.out[device.out.length - 1];
check("the frame uses the inline-edited channel and ID",
    !!sent && sent.bytes[9] === 2
    && (new DataView(sent.bytes.buffer).getUint32(4, true) & 0x1FFFFFFF) === 0x1ABCDEF,
    JSON.stringify(sent && [sent.bytes[9], new DataView(sent.bytes.buffer).getUint32(4, true).toString(16)]));

/* editing must survive the repaints the frame counter causes */
commitEditor(editorIn(0, "cycle"), "0");
await sleep(20);
const idEditor = editorIn(0, "id");
idEditor.focus();
idEditor.value = "7FF";
idEditor.dispatchEvent(new window.Event("input", { bubbles: true }));
await sleep(250);                                  /* several renders in between */
check("a focused editor is not overwritten by repaints",
    window.document.activeElement === idEditor && idEditor.value === "7FF",
    `${window.document.activeElement === idEditor} / ${idEditor.value}`);

/* the row's double-click-to-send must not fire while editing a cell */
const commitFix = () => {
    const el = editorIn(0, "id");
    el.value = "0FF";
    el.dispatchEvent(new window.Event("change", { bubbles: true }));
};
commitFix();
await sleep(30);
device.out.length = 0;
const editingCell = editorIn(0, "id");
editingCell.dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
editingCell.dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
await sleep(150);
check("double-clicking an editor does not send a frame", device.out.length === 0, String(device.out.length));

/* and the row itself still sends on a double-click */
device.out.length = 0;
const dataCell0 = txRowAt(0).children[4];
dataCell0.dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
dataCell0.dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
await waitFor("double-click send", () => device.out.length > 0, 1000);
check("double-clicking the row still sends once", device.out.length === 1, String(device.out.length));

console.log("== DEBUG column ==");
const dbgLines = () => Array.from(window.document.querySelectorAll("#debugLog .dbg-line"));
const dbgText = () => dbgLines().map((l) => l.textContent).join("\n");
const labelOf = (l) => l.querySelector(".dbg-label")?.textContent;

const workspaceCols = () => window.getComputedStyle($("debugPane").parentElement).gridTemplateColumns;
check("without debug mode the main column is the only one",
    !/1240px/.test(workspaceCols()), workspaceCols());
check("the debug column starts hidden",
    !window.document.body.classList.contains("debug")
    && window.getComputedStyle($("debugPane")).display === "none",
    window.getComputedStyle($("debugPane")).display);

click("btnDebug");
await sleep(20);
check("the button opens a column on the right",
    window.document.body.classList.contains("debug")
    && window.getComputedStyle($("debugPane")).display !== "none",
    window.getComputedStyle($("debugPane")).display);
check("the main column keeps the width it has without debug mode",
    /1240px/.test(workspaceCols()) && !/1240px.*1240px/.test(workspaceCols()), workspaceCols());
check("it shows the commands sent while connecting",
    /SET_HOST_FORMAT/.test(dbgText()) && /SET_DEVICE_MODE/.test(dbgText())
    && /SET_BIT_TIMING/.test(dbgText()) && /GET_CAPABILITIES/.test(dbgText()),
    dbgLines().slice(0, 3).map((l) => l.textContent).join(" | "));
check("and says what each of them meant",
    /0xbeef/.test(dbgText()) && /start/.test(dbgText()) && /sp 80/.test(dbgText()),
    "");
check("device answers are marked as incoming",
    dbgLines().some((l) => l.classList.contains("dbg-in")), "");
check("lines are numbered, not timestamped",
    dbgLines().every((l) => /^#\d+$/.test(l.querySelector(".dbg-time").textContent))
    && dbgLines()[0].querySelector(".dbg-time").textContent === "#1",
    dbgLines().slice(0, 3).map((l) => l.querySelector(".dbg-time").textContent).join(" "));
check("the clock moved into the hover",
    /^\d\d:\d\d:\d\d\.\d\d\d\n/.test(dbgLines()[0].title), dbgLines()[0].title.slice(0, 30));
check("the vendor resistor-state request is read and decoded",
    /GET_RESISTER_STATE/.test(dbgText()) && /off/.test(dbgText()),
    dbgLines().filter((l) => /GET_RESISTER_STATE/.test(l.textContent)).slice(0, 1).map((l) => l.textContent).join(""));
check("the hover names the constant it maps to",
    /GS_USB_BREQ_GET_CAN_RESISTER_ENABLE_STATE/.test(
        dbgLines().find((l) => labelOf(l) === "GET_RESISTER_STATE").title),
    dbgLines().find((l) => labelOf(l) === "GET_RESISTER_STATE").title.replace(/\n/g, " | "));


/* one short line per interaction, the decode only on hover */
const timingLine = dbgLines().find((l) => labelOf(l) === "SET_BIT_TIMING");
check("a line is a short summary", /CH2 arb 500000 bps, sp 80/.test(timingLine.textContent),
    timingLine.textContent);
check("the line shows no packet dump", !/prop=/.test(timingLine.textContent) && !/wValue/.test(timingLine.textContent),
    timingLine.textContent);
check("the decode waits on hover",
    /prop_seg=0/.test(timingLine.title) && /wValue=/.test(timingLine.title)
    && /GS_USB_BREQ_BITTIMING/.test(timingLine.title),
    timingLine.title.replace(/\n/g, " | "));

/* Normal frames are opt-in: with the box cleared not even a record is made, so
 * a busy bus costs nothing while debugging commands. */
click("btnDebugClear");
await sleep(20);
device.queueRx(rxFrame(1, 0x0AA, [0x01, 0x02]));
txRowAt(0).querySelector('button[data-act="send"]').click();
await sleep(300);
check("no frame records while the box is clear", dbgLines().length === 0,
    `${dbgLines().length} line(s): ${dbgText().split("\n").slice(0, 2).join(" | ")}`);

setCheckbox($("debugFrames"), true);
await sleep(20);
device.queueRx(rxFrame(1, 0x0AA, [0x01, 0x02]));
txRowAt(0).querySelector('button[data-act="send"]').click();
await waitFor("frame records", () => /bulk TX frame/.test(dbgText()) && /bulk RX/.test(dbgText()), 1000);
check("asking for frames records TX, RX and echoes",
    /bulk TX frame/.test(dbgText()) && /bulk RX/.test(dbgText()), dbgText());
const txFrameLine = dbgLines().find((l) => labelOf(l) === "bulk TX frame");
check("frames get the same treatment",
    /id=0x/.test(txFrameLine.textContent) && !/usb frame/.test(txFrameLine.textContent)
    && /usb frame/.test(txFrameLine.title),
    txFrameLine.title.replace(/\n/g, " | "));

setCheckbox($("debugFrames"), false);
await sleep(20);
check("clearing the box hides the frame lines again", !/bulk TX frame/.test(dbgText()), dbgText());

click("btnDebugClear");
await sleep(20);
check("clear empties the column", dbgLines().length === 0 && /^0 lines$/.test($("debugCount").textContent),
    `${dbgLines().length} / ${$("debugCount").textContent}`);

setCheckbox($("debugFrames"), true);
await sleep(20);
txRowAt(0).querySelector('button[data-act="send"]').click();
await waitFor("TX line in the debug column", () => /bulk TX frame/.test(dbgText()), 1000);
check("a command is logged as it happens", /bulk TX frame/.test(dbgText()), dbgText());
check("the line count follows", /^[1-9]\d* lines$/.test($("debugCount").textContent), $("debugCount").textContent);

click("btnDebug");
await sleep(20);
check("the column can be closed again",
    !window.document.body.classList.contains("debug")
    && window.getComputedStyle($("debugPane")).display === "none",
    window.getComputedStyle($("debugPane")).display);

/* it keeps collecting while the column is out of the way */
txRowAt(0).querySelector('button[data-act="send"]').click();
await sleep(200);
click("btnDebug");
await sleep(20);
const txLines = dbgLines().filter((l) => labelOf(l) === "bulk TX frame");
check("and keeps collecting while hidden", txLines.length >= 2, `${txLines.length} line(s)`);

console.log("== control-transfer decoding ==");
const { GsUsbAdapter, GS_REQ_SET_INTERFACENUMBER_ENDPOINT } = await import(`${CAN}/gs_usb.js`);
const decoder = new GsUsbAdapter();
const u32bytes = (...values) => {
    const b = new Uint8Array(values.length * 4);
    const dv = new DataView(b.buffer);
    values.forEach((v, i) => dv.setUint32(i * 4, v >>> 0, true));
    return b;
};
const endpointDecode = decoder._describeControl(GS_REQ_SET_INTERFACENUMBER_ENDPOINT, 2, 1, null);
check("the endpoint hint decodes channel and interface",
    /CH3 interface 1/.test(endpointDecode.brief)
    && /GS_USB_BREQ_SET_INTERFACENUMBER_ENDPOINT/.test(endpointDecode.full)
    && /wValue=2/.test(endpointDecode.full),
    `${endpointDecode.brief} | ${endpointDecode.full.replace(/\n/g, " | ")}`);

decoder.capClassic = { fclk_can: 80000000 };
const timingDecode = decoder._describeControl(GS_REQ.BIT_TIMING, 1,
    decoder.interfaceNumber || 0, u32bytes(0, 127, 32, 32, 1));
check("bit timing decodes every field",
    /CH2 arb 500000 bps, sp 80.0%/.test(timingDecode.brief)
    && /prop_seg=0 phase_seg1=127 phase_seg2=32 sjw=32 brp=1/.test(timingDecode.full)
    && /160 tq per bit/.test(timingDecode.full),
    `${timingDecode.brief} | ${timingDecode.full.replace(/\n/g, " | ")}`);

const capsDecode = decoder._describeControl(GS_REQ.BT_CONST, 0, 0,
    u32bytes(0x0001 | 0x0400 | 0x0800, 80000000, 2, 256, 2, 128, 128, 1, 512, 1));
check("capabilities decode the feature bits and the limits",
    /fclk 80.0 MHz/.test(capsDecode.brief)
    && /LISTEN_ONLY\|BT_CONST_EXT\|TERMINATION/.test(capsDecode.full)
    && /tseg1 2\.\.256/.test(capsDecode.full)
    && /brp 1\.\.512 inc 1/.test(capsDecode.full),
    capsDecode.full.replace(/\n/g, " | "));

const extCapsDecode = decoder._describeControl(GS_REQ.BT_CONST_EXT, 0, 0,
    u32bytes(0x0400, 80000000, 2, 256, 2, 128, 128, 1, 512, 1, 1, 32, 2, 16, 16, 1, 32, 1));
check("the FD capabilities add the data-phase limits",
    /data: tseg1 1\.\.32/.test(extCapsDecode.full), extCapsDecode.full.replace(/\n/g, " | "));

console.log(failures === 0 ? "\nUI CHECKS PASSED" : `\n${failures} UI CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
