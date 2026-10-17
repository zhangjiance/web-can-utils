/**
 * Headless check for gs_usb.js (no dependencies).
 *
 * Run:  npm test
 *
 * Covers: standard Linux gs_usb layout (one vendor interface, icount+1
 * channels), how many interfaces exist cannot change the channel model (a DFU
 * interface in front is ignored), per-channel control addressing, TX routing
 * via the frame's channel byte, RX channel mapping, custom bit timing (applied
 * and refused when out of the device's range) and termination gating.
 */
const { xcanRegistry } = await import(new URL("../can_hal.js", import.meta.url).href);
await import(new URL("../gs_usb.js", import.meta.url).href);

const GS_REQ = {
    HOST_FORMAT: 0, BIT_TIMING: 1, MODE: 2, BT_CONST: 4, DEVICE_CONFIG: 5,
    BIT_TIMING_FD: 10, BT_CONST_EXT: 11, TERMINATION: 12, LAST_ERROR: 22,
};
const FEATURE = 0x0001 | 0x0010 | 0x0080 | 0x0100 | 0x0400 | 0x0800;

class FakeUsbDevice {
    constructor(icount, withDfuInterface = false) {
        this.vendorId = 0x1d50;
        this.productId = 0x606f;
        this.serialNumber = "TEST";
        this.opened = false;
        this.icount = icount;
        this.feature = FEATURE;
        this.ctrl = [];
        this.out = [];
        this.rxQueue = new Map();
        this.claimed = [];
        this.inCalls = 0;

        const interfaces = [];
        if (withDfuInterface) {
            interfaces.push({ interfaceNumber: 0, alternates: [{ interfaceClass: 0xfe, endpoints: [] }] });
        }
        interfaces.push({
            interfaceNumber: withDfuInterface ? 1 : 0,
            alternates: [{
                interfaceClass: 0xff,
                endpoints: [
                    { direction: "in", type: "bulk", endpointNumber: 0x81, packetSize: 64 },
                    { direction: "out", type: "bulk", endpointNumber: 0x02, packetSize: 64 },
                ],
            }],
        });
        this._config = { interfaces };
    }

    get configuration() { return this._config; }
    async open() { this.opened = true; }
    async close() { this.opened = false; }
    async claimInterface(n) { this.claimed.push(n); }
    async releaseInterface(n) { this.claimed = this.claimed.filter((c) => c !== n); }
    _put(dv, off, v) { dv.setUint32(off, v >>> 0, true); }

    async controlTransferIn(setup) {
        this.ctrl.push({ request: setup.request, value: setup.value, index: setup.index });
        if (setup.request === GS_REQ.DEVICE_CONFIG) {
            const b = new Uint8Array(12); const dv = new DataView(b.buffer);
            dv.setUint8(3, this.icount);
            this._put(dv, 4, 0x00010008); this._put(dv, 8, 0x01010000);
            return { status: "ok", data: new DataView(b.buffer) };
        }
        if (setup.request === GS_REQ.BT_CONST || setup.request === GS_REQ.BT_CONST_EXT) {
            const len = setup.request === GS_REQ.BT_CONST ? 40 : 72;
            const b = new Uint8Array(len); const dv = new DataView(b.buffer);
            const lim = [2, 256, 2, 128, 128, 1, 512, 1];
            this._put(dv, 0, this.feature); this._put(dv, 4, 80000000);
            lim.forEach((v, i) => this._put(dv, 8 + 4 * i, v));
            if (len === 72) {
                const dlim = [1, 32, 2, 16, 16, 1, 32, 1];
                dlim.forEach((v, i) => this._put(dv, 40 + 4 * i, v));
            }
            return { status: "ok", data: new DataView(b.buffer) };
        }
        if (setup.request === GS_REQ.LAST_ERROR) {
            return { status: "ok", data: new DataView(new Uint8Array([2]).buffer) };
        }
        return { status: "stall", data: null };
    }

    async controlTransferOut(setup, data) {
        this.ctrl.push({
            request: setup.request, value: setup.value, index: setup.index,
            data: data ? Uint8Array.from(data) : null,
        });
        return { status: "ok" };
    }

    async transferOut(ep, data) {
        this.out.push({ ep, bytes: Uint8Array.from(data) });
        return { status: "ok" };
    }

    async transferIn(ep) {
        this.inCalls++;
        const q = this.rxQueue.get(ep & 0x7f);
        if (q && q.length) {
            const bytes = q.shift();
            return { status: "ok", data: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
        }
        await new Promise((r) => setTimeout(r, 2));
        return { status: "ok", data: new DataView(new Uint8Array(0).buffer) };
    }

    queueRx(ep, bytes) {
        const e = ep & 0x7f;
        if (!this.rxQueue.has(e)) this.rxQueue.set(e, []);
        this.rxQueue.get(e).push(Uint8Array.from(bytes));
    }
}

function rxFrame(channel, id, data) {
    const b = new Uint8Array(24);
    const dv = new DataView(b.buffer);
    dv.setUint32(0, 0xffffffff, true);
    dv.setUint32(4, id >>> 0, true);
    dv.setUint8(8, data.length);
    dv.setUint8(9, channel);
    data.forEach((v, i) => dv.setUint8(12 + i, v));
    dv.setUint32(20, 1234, true);
    return b;
}

let failures = 0;
const check = (name, cond, extra = "") => {
    console.log(`  ${cond ? "ok  " : "FAIL"} ${name} ${cond ? "" : extra}`);
    if (!cond) failures++;
};
const Adapter = xcanRegistry.get("gsusb");
const timingOf = (c) => {
    const dv = new DataView(c.data.buffer);
    return { seg1: dv.getUint32(4, true), seg2: dv.getUint32(8, true), sjw: dv.getUint32(12, true), brp: dv.getUint32(16, true) };
};

for (const variant of [
    { name: "1 interface x 4 channels", icount: 3, index: 0, dfu: false },
    { name: "DFU interface in front", icount: 3, index: 1, dfu: true },
]) {
    console.log(`\n== ${variant.name} ==`);
    const dev = new FakeUsbDevice(variant.icount, variant.dfu);
    const adapter = new Adapter();
    adapter.device = dev;
    const rx = [];
    adapter.onReceive((m) => rx.push(m));
    adapter.onError(() => {});

    await adapter.connect();
    check("channels = icount + 1", adapter.deviceInfo.channels === 4, String(adapter.deviceInfo.channels));
    check(`interface ${variant.index} used`, adapter.interfaceNumber === variant.index, String(adapter.interfaceNumber));
    check("only that interface claimed", JSON.stringify(dev.claimed) === JSON.stringify([variant.index]), JSON.stringify(dev.claimed));
    check("device clock + ranges published", adapter.canClockHz === 80000000 && !!adapter.timingLimits.nominal && !!adapter.timingLimits.data);

    dev.ctrl.length = 0;
    await adapter.initBus({ channel: 2, nominalBitrate: 500000, dataBitrate: 2000000, fdMode: true, termination: false });
    const modes = dev.ctrl.filter((c) => c.request === GS_REQ.MODE);
    check("MODE addressed with wValue = channel, wIndex = interface",
        modes.length === 2 && modes.every((c) => c.value === 2 && c.index === variant.index), JSON.stringify(modes));
    check("termination written when the flag is given",
        dev.ctrl.some((c) => c.request === GS_REQ.TERMINATION && c.value === 2 && c.index === variant.index));
    check("capabilities not re-read per start", !dev.ctrl.some((c) => c.request === GS_REQ.BT_CONST));

    dev.out.length = 0;
    await adapter.sendMessage({ id: 0x123, data: [1, 2], channel: 2, fd: false, extended: false, rtr: false });
    const tx = dev.out[0];
    check("TX on the interface OUT endpoint", !!tx && tx.ep === 0x02, `ep=0x${tx?.ep.toString(16)}`);
    check("TX frame carries device channel 2", tx && tx.bytes[9] === 2, String(tx?.bytes[9]));

    await adapter.startReceive();
    dev.queueRx(0x81, rxFrame(3, 0x321, [0xde, 0xad]));
    await new Promise((r) => setTimeout(r, 60));
    check("RX frame mapped to its channel", rx.length === 1 && rx[0].channel === 3 && rx[0].id === 0x321,
        JSON.stringify(rx.map((m) => [m.channel, m.id])));

    dev.ctrl.length = 0;
    await adapter.initBus({
        channel: 2, nominalBitrate: 500000, dataBitrate: 2000000, fdMode: true,
        customTiming: { nominal: { brp: 4, seg1: 31, seg2: 8, sjw: 1 }, data: { brp: 2, seg1: 13, seg2: 6, sjw: 1 } },
    });
    const nom = timingOf(dev.ctrl.find((c) => c.request === GS_REQ.BIT_TIMING));
    const dat = timingOf(dev.ctrl.find((c) => c.request === GS_REQ.BIT_TIMING_FD));
    const plan = adapter.planPreset({ nominalBitrate: 500000, dataBitrate: 2000000, fdMode: true });
    check("preset plan is 80 % / 80 %",
        Math.abs(plan.nominal.samplePoint - 0.8) < 1e-9 && Math.abs(plan.data.samplePoint - 0.8) < 1e-9,
        `${plan.nominal.samplePoint} / ${plan.data.samplePoint}`);

    check("custom nominal timing applied", nom.brp === 4 && nom.seg1 === 31 && nom.seg2 === 8 && nom.sjw === 1, JSON.stringify(nom));
    check("custom data timing applied", dat.brp === 2 && dat.seg1 === 13 && dat.seg2 === 6 && dat.sjw === 1, JSON.stringify(dat));

    let rejected = "";
    try {
        await adapter.initBus({
            channel: 2, nominalBitrate: 500000, fdMode: true,
            customTiming: { nominal: { brp: 4, seg1: 9999, seg2: 8, sjw: 1 } },
        });
    } catch (e) { rejected = e.message; }
    check("out-of-range timing refused", /out of device range/.test(rejected), rejected);

    adapter.rxRunning = false;
    await adapter.disconnect();
    check("interface released", dev.claimed.length === 0, JSON.stringify(dev.claimed));
}

console.log("\n== termination is only requested when advertised ==");
for (const c of [
    { name: "advertised", feature: FEATURE, expect: true },
    { name: "not advertised", feature: FEATURE & ~0x0800, expect: false },
]) {
    const dev = new FakeUsbDevice(3);
    dev.feature = c.feature;
    const adapter = new Adapter();
    adapter.device = dev;
    await adapter.connect();
    dev.ctrl.length = 0;
    await adapter.initBus({ channel: 0, nominalBitrate: 500000, fdMode: false, termination: true });
    const reqs = dev.ctrl.filter((x) => x.request === GS_REQ.TERMINATION);
    check(`${c.name}: termination ${c.expect ? "sent" : "not sent"}`, (reqs.length > 0) === c.expect, JSON.stringify(reqs));
    adapter.rxRunning = false;
    await adapter.disconnect();
}

console.log("\n== reader lifecycle across disconnect / reconnect ==");
{
    const dev = new FakeUsbDevice(3);
    const first = new Adapter();
    first.device = dev;
    await first.connect();
    check("reader active after connect", first._rxActive === true);

    await first.disconnect();
    check("reader state cleared on disconnect",
        first._rxActive === false && first._rxGeneration > 0,
        `active=${first._rxActive} gen=${first._rxGeneration}`);

    /* The page's "Add device" again: a fresh adapter on the same device. */
    const second = new Adapter();
    second.device = dev;
    await second.connect();
    check("reader active again after reconnect", second._rxActive === true);

    dev.inCalls = 0;
    dev.out.length = 0;
    await second.startReceive();
    await second.sendMessage({ id: 0x111, data: [9], channel: 0, fd: false, extended: false, rtr: false });
    await new Promise((r) => setTimeout(r, 60));
    check("IN endpoint drained again after reconnect", dev.inCalls > 0, `inCalls=${dev.inCalls}`);
    check("TX after reconnect reaches the device", dev.out.length === 1, `out=${dev.out.length}`);

    /* A reader lost mid-session (e.g. an aborted transfer) must be re-armed by
     * the next transmission instead of failing with a timeout. */
    second._rxActive = false;
    second._rxGeneration++;
    dev.out.length = 0;
    await second.sendMessage({ id: 0x222, data: [8], channel: 0, fd: false, extended: false, rtr: false });
    check("lost reader re-armed by the next TX", second._rxActive === true);
    check("that TX still went out", dev.out.length === 1, `out=${dev.out.length}`);

    second.rxRunning = false;
    await second.disconnect();
}

console.log(failures === 0 ? "\nGS_USB CHECKS PASSED" : `\n${failures} GS_USB CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
