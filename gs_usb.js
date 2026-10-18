/**
 * GS_USB / Candlelight protocol adapter for XCAN (WebUSB)
 *
 * Channel model
 * -------------
 * This adapter speaks the standard gs_usb protocol the way Linux implements it,
 * which is the only layout this page supports:
 *
 *   - one vendor interface carries `icount + 1` CAN channels, where icount comes
 *     from the device config reply (GS_USB_BREQ_DEVICE_CONFIG),
 *   - control requests name the channel in wValue (per device requests use 1,
 *     like the Linux driver),
 *   - every frame carries its channel in the gs_host_frame::channel byte, and
 *     the outgoing frame's channel byte is what routes a transmission
 *     (candleLight's USBD_GS_CAN_DataOut() looks at frame.channel),
 *   - received frames are marked with echo_id == 0xFFFFFFFF,
 *   - hardware timestamps are requested in GS_CAN_MODE_START whenever the device
 *     advertises GS_CAN_FEATURE_HW_TIMESTAMP, because that flag is what makes the
 *     device append the u32 timestamp to every frame (and so what the Cycle
 *     column is computed from).
 *
 * Nothing is inferred from the number of vendor interfaces the device exposes,
 * so extra interfaces (a DFU runtime interface, for example) cannot confuse the
 * channel handling.
 *
 * The vendor's multi-interface personality (HSCanT GSCAN: four interfaces with
 * one channel each) is deliberately NOT supported by this page - it addresses
 * channels differently (wIndex = interface) and exists for the vendor's own
 * tool.
 */

import {
    XCanInterface,
    XCanDeviceInfo,
    XCanMessage,
    xcanRegistry
} from "./can_hal.js";

// GS/ELM requests
/* Request numbers follow candleLight's gs_usb.h plus the HSCanT vendor
 * extensions (15..17). */
const GS_REQ_SET_HOST_FORMAT = 0;
const GS_REQ_SET_BIT_TIMING = 1;
const GS_REQ_SET_DEVICE_MODE = 2;
const GS_REQ_BERR = 3;
const GS_REQ_GET_CAPABILITIES = 4;
const GS_REQ_GET_DEVICE_VERSION = 5;
const GS_REQ_GET_TIMESTAMP = 6;
const GS_REQ_IDENTIFY = 7;
const GS_REQ_SET_BIT_TIMING_FD = 10;
const GS_REQ_GET_CAPABILITIES_FD = 11;
const GS_REQ_SET_TERMINATION = 12;
const GS_REQ_GET_TERMINATION = 13;
const GS_REQ_GET_STATE = 14;
const GS_REQ_GET_CAN_RESISTER_ENABLE_STATE = 15;
const GS_REQ_SET_CAN_RESISTER_ENABLE_STATE = 16;
const GS_REQ_SET_INTERFACENUMBER_ENDPOINT = 17;

const ELM_REQ_GET_LAST_ERROR = 22;

/* Short label for the log line, and the constant it stands for (shown on hover
 * so the name in candleLight's gs_usb.h can be looked up). */
const GS_REQ_NAMES = {
    [GS_REQ_SET_HOST_FORMAT]: "SET_HOST_FORMAT",
    [GS_REQ_SET_BIT_TIMING]: "SET_BIT_TIMING",
    [GS_REQ_SET_DEVICE_MODE]: "SET_DEVICE_MODE",
    [GS_REQ_BERR]: "BERR",
    [GS_REQ_GET_CAPABILITIES]: "GET_CAPABILITIES",
    [GS_REQ_GET_DEVICE_VERSION]: "GET_DEVICE_VERSION",
    [GS_REQ_GET_TIMESTAMP]: "GET_TIMESTAMP",
    [GS_REQ_IDENTIFY]: "IDENTIFY",
    [GS_REQ_SET_BIT_TIMING_FD]: "SET_BIT_TIMING_FD",
    [GS_REQ_GET_CAPABILITIES_FD]: "GET_CAPABILITIES_FD",
    [GS_REQ_SET_TERMINATION]: "SET_TERMINATION",
    [GS_REQ_GET_TERMINATION]: "GET_TERMINATION",
    [GS_REQ_GET_STATE]: "GET_STATE",
    [GS_REQ_GET_CAN_RESISTER_ENABLE_STATE]: "GET_RESISTER_STATE",
    [GS_REQ_SET_CAN_RESISTER_ENABLE_STATE]: "SET_RESISTER_STATE",
    [GS_REQ_SET_INTERFACENUMBER_ENDPOINT]: "SET_INTERFACE_ENDPOINT",
    [ELM_REQ_GET_LAST_ERROR]: "GET_LAST_ERROR",
};

const GS_REQ_CANONICAL = {
    [GS_REQ_SET_HOST_FORMAT]: "GS_USB_BREQ_HOST_FORMAT",
    [GS_REQ_SET_BIT_TIMING]: "GS_USB_BREQ_BITTIMING",
    [GS_REQ_SET_DEVICE_MODE]: "GS_USB_BREQ_MODE",
    [GS_REQ_BERR]: "GS_USB_BREQ_BERR",
    [GS_REQ_GET_CAPABILITIES]: "GS_USB_BREQ_DEVICE_CONFIG",
    [GS_REQ_GET_DEVICE_VERSION]: "GS_USB_BREQ_DEVICE_CONFIG (per device)",
    [GS_REQ_GET_TIMESTAMP]: "GS_USB_BREQ_TIMESTAMP",
    [GS_REQ_IDENTIFY]: "GS_USB_BREQ_IDENTIFY",
    [GS_REQ_SET_BIT_TIMING_FD]: "GS_USB_BREQ_DATA_BITTIMING",
    [GS_REQ_GET_CAPABILITIES_FD]: "GS_USB_BREQ_BT_CONST_EXT",
    [GS_REQ_SET_TERMINATION]: "GS_USB_BREQ_SET_TERMINATION",
    [GS_REQ_GET_TERMINATION]: "GS_USB_BREQ_GET_TERMINATION",
    [GS_REQ_GET_STATE]: "GS_USB_BREQ_GET_STATE",
    [GS_REQ_GET_CAN_RESISTER_ENABLE_STATE]: "GS_USB_BREQ_GET_CAN_RESISTER_ENABLE_STATE",
    [GS_REQ_SET_CAN_RESISTER_ENABLE_STATE]: "GS_USB_BREQ_SET_CAN_RESISTER_ENABLE_STATE",
    [GS_REQ_SET_INTERFACENUMBER_ENDPOINT]: "GS_USB_BREQ_SET_INTERFACENUMBER_ENDPOINT",
    [ELM_REQ_GET_LAST_ERROR]: "vendor GET_LAST_ERROR (22)",
};

function gsReqName(request) {
    return GS_REQ_NAMES[request] || `REQ_${request}`;
}

function gsReqCanonical(request) {
    return GS_REQ_CANONICAL[request] || `request ${request}`;
}

/* Feature/mode bits, straight out of gs_usb.h. */
const GS_FEATURE_BITS = [
    [1 << 0, "LISTEN_ONLY"], [1 << 1, "LOOP_BACK"], [1 << 2, "TRIPLE_SAMPLE"],
    [1 << 3, "ONE_SHOT"], [1 << 4, "HW_TIMESTAMP"], [1 << 5, "IDENTIFY"],
    [1 << 6, "USER_ID"], [1 << 7, "PAD_PKTS_TO_MAX_PKT_SIZE"], [1 << 8, "FD"],
    [1 << 9, "USB_QUIRK_LPC546XX"], [1 << 10, "BT_CONST_EXT"],
    [1 << 11, "TERMINATION"], [1 << 12, "BERR_REPORTING"],
];

const GS_MODE_BITS = [
    [1 << 0, "LISTEN_ONLY"], [1 << 1, "LOOP_BACK"], [1 << 2, "TRIPLE_SAMPLE"],
    [1 << 3, "ONE_SHOT"], [1 << 4, "HW_TIMESTAMP"], [1 << 7, "PAD_PKTS_TO_MAX_PKT_SIZE"],
    [1 << 8, "FD"], [1 << 10, "BT_CONST_EXT"], [1 << 12, "BERR_REPORTING"],
];

const GS_MODES = { 0: "reset", 1: "start" };

function namedBits(value, table) {
    const names = table.filter(([bit]) => (value & bit) !== 0).map(([, name]) => name);
    return names.length ? `${names.join("|")} (0x${(value >>> 0).toString(16)})` : `none (0x${(value >>> 0).toString(16)})`;
}

function hexBytes(bytes) {
    if (!bytes || !bytes.byteLength) {
        return "";
    }
    return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join(" ");
}

/* Short form for a control payload: byte dump when it is short, size when not. */
function hexOrSize(bytes) {
    if (!bytes || !bytes.byteLength) {
        return "no data";
    }
    return bytes.byteLength <= 8 ? hexBytes(bytes) : `${bytes.byteLength} bytes`;
}

function u32(view, offset) {
    return view.getUint32(offset, true);
}

function decodeModeFlags(flags) {
    return namedBits(flags, GS_MODE_BITS);
}

/* struct gs_device_bt_const / gs_device_bt_const_extended */
function decodeBtConst(bytes, extended) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const limits = (off) => `tseg1 ${u32(dv, off)}..${u32(dv, off + 4)}`
        + ` tseg2 ${u32(dv, off + 8)}..${u32(dv, off + 12)}`
        + ` sjw ${u32(dv, off + 16)}`
        + ` brp ${u32(dv, off + 20)}..${u32(dv, off + 24)} inc ${u32(dv, off + 28)}`;
    const fclk = u32(dv, 4);
    return {
        brief: `fclk ${(fclk / 1e6).toFixed(1)} MHz`,
        full: `feature=${namedBits(u32(dv, 0), GS_FEATURE_BITS)} · fclk_can=${fclk} Hz`
            + ` · arbitration: ${limits(8)}`
            + (extended && bytes.byteLength >= 72 ? ` · data: ${limits(40)}` : ""),
    };
}

/* struct gs_device_config */
function decodeDeviceConfig(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const sw = u32(dv, 4);
    const hw = u32(dv, 8);
    return {
        brief: `icount=${dv.getUint8(3)} sw=0x${sw.toString(16)} hw=0x${hw.toString(16)}`,
        full: `icount=${dv.getUint8(3)} (first channel of this interface)`
            + ` sw_version_bcd=0x${sw.toString(16).padStart(8, "0")}`
            + ` hw_version_bcd=0x${hw.toString(16).padStart(8, "0")}`,
    };
}

/* struct gs_device_bittiming */
function decodeBtTiming(bytes, clock) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const prop = u32(dv, 0);
    const seg1 = u32(dv, 4);
    const seg2 = u32(dv, 8);
    const sjw = u32(dv, 12);
    const brp = u32(dv, 16);
    const tq = 1 + prop + seg1 + seg2;
    const sp = ((prop + seg1 + 1) / tq * 100).toFixed(1);
    const bitrate = clock && brp ? Math.round(clock / (tq * brp)) : null;
    return {
        brief: (bitrate ? `${bitrate} bps, ` : "") + `sp ${sp}%`,
        full: `prop_seg=${prop} phase_seg1=${seg1} phase_seg2=${seg2} sjw=${sjw} brp=${brp}`
            + ` -> ${tq} tq per bit, sample point ${sp}%`
            + (bitrate ? `, ${bitrate} bps at ${(clock / 1e6).toFixed(1)} MHz` : ""),
    };
}

/* One byte terminal resistor state (vendor extension). */
function decodeResisterState(byte) {
    return byte
        ? { brief: "on", full: "state byte 0x01: 120 ohm terminators engaged" }
        : { brief: "off", full: "state byte 0x00: terminators disengaged" };
}

/* struct gs_device_termination_state: 0 off, 1 on */
function decodeTerminationState(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const state = u32(dv, 0);
    return {
        brief: state === 1 ? "on" : state === 0 ? "off" : `state ${state}`,
        full: `state=${state} (${state === 1 ? "on" : state === 0 ? "off" : "not supported"})`
            + " · GS_CAN_TERMINATION_STATE_OFF=0 / _ON=1",
    };
}

/* One frame, "ch2 id=0xFF classic/STD dlc=4" */
function describeFrame(message) {
    const flags = [
        message.fd ? "FD" : "classic",
        message.brs ? "BRS" : "",
        message.rtr ? "RTR" : "",
        message.extended ? "EXT" : "STD",
    ].filter(Boolean).join("/");
    /* the UI counts channels from 1 (CH1 = host channel 0): keep the log in
     * step with the tables */
    return `CH${(message.channel ?? 0) + 1} id=0x${Number(message.id).toString(16).toUpperCase()}`
        + ` ${flags} dlc=${(message.data || []).length}`;
}

function describeFrameData(message) {
    const data = Array.from(message.data || []).map((b) => b.toString(16).padStart(2, "0")).join(" ");
    return data ? `data=${data}` : "no data";
}

// GS mode/flags
const GS_MODE_RESET = 0;
const GS_MODE_START = 1;

const GS_DEV_FLAG_LISTEN_ONLY = 0x00001;
const GS_DEV_FLAG_LOOP_BACK = 0x00002;
/* GS_CAN_FEATURE_HW_TIMESTAMP / GS_CAN_MODE_HW_TIMESTAMP share this bit: gs_usb
 * reports a capability and asks for it with the same numbering. */
const GS_DEV_FLAG_HW_TIMESTAMP = 1 << 4;
const GS_DEV_FLAG_CAN_FD = 0x00100;
const GS_DEV_FLAG_BIT_TIMING_FD = 0x00400;
const GS_DEV_FLAG_TERMINATION = 0x00800;

// Candlelight legacy frame flags
const GS_CAN_FLAG_OVERFLOW = 1 << 0;
const GS_CAN_FLAG_FD = 1 << 1;
const GS_CAN_FLAG_BRS = 1 << 2;
const GS_CAN_FLAG_ESI = 1 << 3;

const CAN_ID_FLAG_ERR = 0x20000000;
const CAN_ID_FLAG_RTR = 0x40000000;
const CAN_ID_FLAG_EXT = 0x80000000;
const CAN_ID_MASK = 0x1fffffff;

const LEGACY_ECHO_RX = 0xffffffff;

// gs_device_config / kDeviceVersion is 12 bytes (Linux asks for exactly 12).
const GS_DEVICE_VERSION_LEN = 12;
const GS_BT_CONST_LEN = 40;
const GS_BT_CONST_EXT_LEN = 72;
const GS_HOST_FRAME_LEN = 80;

const DLC2LEN = [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64];
const LEN2DLC = [
    0, 1, 2, 3, 4, 5, 6, 7, 8,
    9, 9, 9, 9,
    10, 10, 10, 10,
    11, 11, 11, 11,
    12, 12, 12, 12,
    13, 13, 13, 13, 13, 13, 13, 13,
    14, 14, 14, 14, 14, 14, 14, 14,
    14, 14, 14, 14, 14, 14, 14, 14,
    15, 15, 15, 15, 15, 15, 15, 15,
    15, 15, 15, 15, 15, 15, 15, 15
];

/*
 * CAN error frames.  can_id carries CAN_ERR_FLAG plus a bitmask of error
 * classes, and the eight payload bytes follow the kernel's struct can_frame
 * error layout (include/uapi/linux/can/error.h, which candleLight's gs_usb.h
 * mirrors):
 *
 *     data[0] arbitration-lost bit   data[1] controller state
 *     data[2] protocol error type    data[3] protocol error location
 *     data[4] transceiver status     data[5] unused
 *     data[6] TX error counter       data[7] RX error counter
 *
 * The names below are can-utils' (lib.c: error_classes[], controller_problems[],
 * protocol_violation_types[], protocol_violation_locations[]) so a decoded
 * status carries the same vocabulary `candump -e "canX,#FFFFFFFF"` uses.
 * app.js then renders it in a shorter, labelled form for the table.
 */
const CAN_ERR_CLASS_MASK = 0x1fffffff;

const CAN_ERR_TX_TIMEOUT = 0x001;
const CAN_ERR_LOSTARB = 0x002;
const CAN_ERR_CRTL = 0x004;
const CAN_ERR_PROT = 0x008;
const CAN_ERR_TRX = 0x010;
const CAN_ERR_ACK = 0x020;
const CAN_ERR_BUSOFF = 0x040;
const CAN_ERR_BUSERROR = 0x080;
const CAN_ERR_RESTARTED = 0x100;
const CAN_ERR_CNT = 0x200;

const CAN_ERR_CLASSES = [
    [CAN_ERR_TX_TIMEOUT, "tx-timeout"],
    [CAN_ERR_LOSTARB, "lost-arbitration"],
    [CAN_ERR_CRTL, "controller-problem"],
    [CAN_ERR_PROT, "protocol-violation"],
    [CAN_ERR_TRX, "transceiver-status"],
    [CAN_ERR_ACK, "no-acknowledgement-on-tx"],
    [CAN_ERR_BUSOFF, "bus-off"],
    [CAN_ERR_BUSERROR, "bus-error"],
    [CAN_ERR_RESTARTED, "restarted-after-bus-off"],
    [CAN_ERR_CNT, "error-counter-tx-rx"]
];

/* data[1] */
const CAN_ERR_CTRL_NAMES = [
    "rx-overflow",
    "tx-overflow",
    "rx-error-warning",
    "tx-error-warning",
    "rx-error-passive",
    "tx-error-passive",
    "back-to-error-active"
];

/* data[2] */
const CAN_ERR_PROT_NAMES = [
    "single-bit-error",
    "frame-format-error",
    "bit-stuffing-error",
    "tx-dominant-bit-error",
    "tx-recessive-bit-error",
    "bus-overload",
    "active-error",
    "error-on-tx"
];

/* data[3]: can-utils' protocol_violation_locations[], indexed by the field value */
const CAN_ERR_PROT_LOCATIONS = [
    "unspecified", "unspecified",
    "id.28-to-id.21", "start-of-frame", "bit-srtr", "bit-ide",
    "id.20-to-id.18", "id.17-to-id.13", "crc-sequence", "reserved-bit-0",
    "data-field", "data-length-code", "bit-rtr", "reserved-bit-1",
    "id.4-to-id.0", "id.12-to-id.5", "unspecified", "active-error-flag",
    "intermission", "tolerate-dominant-bits", "unspecified", "unspecified",
    "passive-error-flag", "error-delimiter", "crc-delimiter",
    "acknowledge-slot", "end-of-frame", "acknowledge-delimiter",
    "overload-flag", "unspecified", "unspecified", "unspecified"
];

/* The names of the bits set in a class payload byte (can-utils snprintf_error_data()). */
function errorBitNames(value, names) {
    const out = [];
    for (let i = 0; i < names.length; i++) {
        if (value & (1 << i)) out.push(names[i]);
    }
    return out;
}

/*
 * Decode one error frame into the fields app.js formats.  Error frames are
 * always classic - the CAN-FD flag is not part of them and the kernel rejects a
 * frame whose layout does not match its flag byte - so the payload starts right
 * after the 12 byte header, at offset 12.
 */
function decodeErrorFrame(rawCanId, dv, byteLength) {
    const classBits = rawCanId & CAN_ERR_CLASS_MASK;
    const classes = [];
    for (const [bit, name] of CAN_ERR_CLASSES) {
        if (classBits & bit) classes.push(name);
    }

    const data = [];
    for (let i = 0; i < 8 && (12 + i) < byteLength; i++) {
        data.push(dv.getUint8(12 + i));
    }

    const ctrl = errorBitNames(data[1] || 0, CAN_ERR_CTRL_NAMES);
    const location = ((data[3] || 0) > 0 && (data[3] || 0) < CAN_ERR_PROT_LOCATIONS.length)
        ? CAN_ERR_PROT_LOCATIONS[data[3]] : null;

    return {
        classBits,
        classes,
        arbitrationBit: data[0] || 0,
        ctrl,
        prot: errorBitNames(data[2] || 0, CAN_ERR_PROT_NAMES),
        location,
        txErrorCounter: data[6] || 0,
        rxErrorCounter: data[7] || 0,
        /* Convenience flags for the status text. */
        busoff: classes.includes("bus-off"),
        warning: ctrl.includes("rx-error-warning") || ctrl.includes("tx-error-warning"),
        /* CAN_ERR_CNT marks the counters as valid; can-utils prints them either
         * way (lib.c:873), so this only matters to hosts that check the class. */
        countersValid: (classBits & CAN_ERR_CNT) !== 0
    };
}

/*
 * What a frame carrying GS_CAN_FLAG_OVERFLOW means: messages were lost because
 * the device's RX FIFO was full.  The kernel's gs_usb driver reports that as a
 * CAN_ERR_CRTL{rx-overflow} error frame next to the frame that carries the flag
 * (drivers/net/can/usb/gs_usb.c, gs_usb_receive_bulk_callback(): rx_over_errors++
 * and alloc_can_err_skb()).  This UI is the driver here, so build the same status.
 */
function overflowStatus(channel) {
    return {
        channel,
        errorFrame: true,
        overflow: true,
        classBits: CAN_ERR_CRTL,
        classes: ["controller-problem"],
        arbitrationBit: 0,
        ctrl: ["rx-overflow"],
        prot: [],
        location: null,
        txErrorCounter: 0,
        rxErrorCounter: 0,
        busoff: false,
        warning: false,
        countersValid: false
    };
}

class GsUsbAdapter extends XCanInterface {
    constructor() {
        super();

        this.interfaceNumber = 0;
        this.msgInEp = 0x81;
        this.msgOutEp = 0x02;
        this.msgInPacketSize = 512;

        // app.js reads these chips for display
        this.cmdOutEp = 0x00;
        this.cmdInEp = 0x00;

        this.rxRunning = false;
        this.txQueue = Promise.resolve();

        this.channel = 0;
        this.echoCounter = 1;

        /* host channel -> { hostChannel, deviceChannel, interfaceNumber,
         *                  inEp, outEp, packetSize } */
        this.channelMap = [];
        this.startedChannels = [];

        /* The vendor interface we run on, and whether we claimed it.
         * `_rxGeneration` invalidates a straggler reader loop after a stop or
         * disconnect so it cannot clear the flag of a newer one. */
        this._rxActive = false;
        this._rxGeneration = 0;
        this._claimedInterfaces = [];

        this.capClassic = null;
        /* host channel -> terminal resistor state the device reported (null when
         * it does not answer the vendor request) */
        this.terminationState = {};
        this.capFd = null;
    }

    get protocolName() {
        return "GS_USB";
    }

    async requestDevice() {
        if (!navigator.usb) {
            throw new Error("WebUSB not supported in this browser");
        }

        const filters = [
            { vendorId: 0x1d50, productId: 0x606f }, // Candlelight/CANable
            { vendorId: 0x1209, productId: 0x2323 },
            { vendorId: 0x1d50 }
        ];

        this.device = await navigator.usb.requestDevice({ filters });
    }

    async connect() {
        if (!this.device) {
            throw new Error("No device selected. Call requestDevice() first.");
        }

        await this.device.open();
        if (this.device.configuration === null) {
            await this.device.selectConfiguration(1);
        }

        /* Find the gs_usb interface: the first vendor interface that answers
         * the (per device) config request wins.  Nothing is inferred from how
         * many interfaces the device has, so an extra interface - a DFU runtime
         * interface, say - can neither add nor remove channels. */
        this._candlelightInterfaces = this._discoverCandlelightInterfaces();
        if (this._candlelightInterfaces.length === 0) {
            throw new Error("No GS/Candlelight bulk interface found");
        }

        let chosen = null;
        for (const itf of this._candlelightInterfaces) {
            try {
                await this.device.claimInterface(itf.interfaceNumber);
            } catch (e) {
                console.warn(`GS claimInterface(${itf.interfaceNumber}) failed:`, e);
                continue;
            }

            try {
                this._deviceConfig = await this._getDeviceVersion(itf);
                chosen = itf;
                this._claimedInterfaces = [itf.interfaceNumber];
                break;
            } catch (e) {
                console.warn(`GS interface ${itf.interfaceNumber} did not answer the device config request:`, e);
                try { await this.device.releaseInterface(itf.interfaceNumber); } catch (_) { /* ignore */ }
            }
        }

        if (!chosen) {
            throw new Error("No GS/Candlelight interface answered the device config request");
        }

        /* Device config: icount tells us how many channels this interface
         * carries (channels = icount + 1). */
        this._buildChannelMap(chosen, this._deviceConfig ? this._deviceConfig.icount : 0);

        const if0 = this.channelMap[0];
        this.interfaceNumber = if0.interfaceNumber;
        this.msgInEp = if0.inEp;
        this.msgOutEp = if0.outEp;
        this.msgInPacketSize = if0.packetSize;

        this.connected = true;

        try {
            this.deviceInfo = await this.getDeviceInfo();
        } catch (e) {
            console.warn("Failed to read GS_USB device info:", e);
            this.deviceInfo = new XCanDeviceInfo({
                name: "GS_USB Device",
                firmware: "Unknown",
                hardware: "Unknown",
                serial: `${this.device.serialNumber || "Unknown"}`,
                channels: this.channelMap.length,
                capabilities: {
                    fd: true,
                    brs: true,
                    listenOnly: true,
                    loopback: true,
                    termination: true
                }
            });
        }

        /* Read the terminal resistor state up front (vendor request 15): the
         * panel shows what the hardware is doing as soon as it opens, before
         * anything is started.  Channels whose board does not answer the vendor
         * request report null and simply show no state. */
        if (this.capClassic && (this.capClassic.feature & GS_DEV_FLAG_TERMINATION)) {
            for (const entry of this.channelMap) {
                this.terminationState[entry.hostChannel] = await this._readResisterState(entry);
            }
        }

        /*
         * Start draining the IN endpoint right away, not only once a bus is
         * started.  The firmware keeps a pool of frame buffers and only re-arms
         * its OUT endpoint while it can hand a buffer back to the host
         * (candleLight: "wait to call PrepareReceive until we have a frame to
         * receive into"), so a host that stops reading IN will make every later
         * transferOut hang - transmissions silently stop working even though
         * the CAN side is fine.
         */
        await this.startReceive();
    }

    async disconnect() {
        this.stopReader();

        /* Stop every channel the host started, then hand the interfaces back. */
        for (const ch of this.startedChannels.slice()) {
            try {
                await this.resetBus(ch);
            } catch (e) {
                console.warn(`GS resetBus(${ch}) during disconnect failed:`, e);
            }
        }
        this.startedChannels = [];

        if (this.device && this.device.opened) {
            for (const interfaceNumber of (this._claimedInterfaces || [])) {
                try {
                    await this.device.releaseInterface(interfaceNumber);
                } catch (e) { /* may already be released */ }
            }

            try {
                await this.device.close();
            } catch (e) {
                console.warn("GS close failed:", e);
            }
        }

        this.device = null;
        this._candlelightInterfaces = null;
        this._claimedInterfaces = [];
        this.connected = false;
        this.channelMap = [];
        this.capClassic = null;
        this.capFd = null;
    }

    /**
     * Start one CAN channel.  May be called for several channels in a row:
     * each one is configured and started independently.
     */
    async initBus(config) {
        if (!this.connected) {
            throw new Error("Device not connected");
        }

        const entry = this._channelEntry(config.channel);
        if (!entry) {
            throw new Error(`Channel ${config.channel} is not available`);
        }

        this.channel = entry.hostChannel;
        this.interfaceNumber = entry.interfaceNumber;
        this.msgInEp = entry.inEp;
        this.msgOutEp = entry.outEp;
        this.msgInPacketSize = entry.packetSize;

        /* Capabilities are identical for every channel, so read them once. */
        if (!this.capClassic) {
            this.capClassic = await this._getCapabilitiesClassic(entry);
        }

        this._publishTimingInfo();
        const hasFd = !!(this.capClassic.feature & GS_DEV_FLAG_CAN_FD);
        if (hasFd && !this.capFd) {
            /* Standard hosts fetch the extended (data phase) descriptor as soon
             * as CAN FD is advertised; some firmwares need it to accept the
             * data bit timing we are about to send. */
            try {
                this.capFd = await this._getCapabilitiesFd(entry);
            } catch (e) {
                this.capFd = null;
            }
        }

        // 1) Host format: little-endian marker (0xbeef).  Per device, so the
        //    Linux driver sends wValue = 1 here.
        const hostFmt = new Uint8Array(4);
        new DataView(hostFmt.buffer).setUint32(0, 0xbeef, true);
        await this._ctrlOut(GS_REQ_SET_HOST_FORMAT, 1, hostFmt, entry.interfaceNumber);
        await this._assertLastError("SET_HOST_FORMAT", entry);

        // 2) Stop this bus before reconfiguring it.
        await this._setDeviceMode(entry, GS_MODE_RESET, 0);
        await this._assertLastError("MODE_RESET_PREP", entry);

        // 3) Configure nominal timing: explicit values when the user picked a
        //    row from the timing table, otherwise solve for the bitrate.
        const nom = this._timingFromCustom(config.customTiming?.nominal, this.timingLimits.nominal, "nominal")
            || this._calcBitTiming(
                this.capClassic?.fclk_can || 160000000,
                config.nominalBitrate,
                this.capClassic?.time || null,
                0.8
            );
        await this._setBitTiming(entry, nom, false);
        await this._assertLastError("SET_BIT_TIMING_NOMINAL", entry);

        // 4) Configure FD data timing if requested
        let modeFlags = 0;

        /* Ask for hardware timestamps when the device offers them.  This flag is
         * what decides the frame layout the device sends: with it every frame
         * carries a u32 timestamp after its data (classic 20 -> 24 bytes, CAN FD
         * 76 -> 80 bytes), without it the field is simply not transmitted and the
         * Cycle column has nothing to work from.  The Linux driver enables it
         * unconditionally whenever the feature is advertised
         * (drivers/net/can/usb/gs_usb.c: "if hardware supports timestamps,
         * enable it"); a device that advertises it must honour it, and one that
         * does not keeps sending the shorter layout. */
        if (this.capClassic.feature & GS_DEV_FLAG_HW_TIMESTAMP) {
            modeFlags |= GS_DEV_FLAG_HW_TIMESTAMP;
        }

        if (config.fdMode) {
            if (!hasFd) {
                throw new Error("Device does not support CAN FD");
            }
            const fdCaps = (this.capFd && this.capFd.time_data) ? this.capFd.time_data : this.capClassic?.time;
            const dataTiming = this._timingFromCustom(config.customTiming?.data, fdCaps, "data")
                || this._calcBitTiming(
                    this.capFd?.fclk_can || this.capClassic?.fclk_can || 160000000,
                    config.dataBitrate || config.nominalBitrate,
                    fdCaps || null,
                    0.8
                );
            await this._setBitTiming(entry, dataTiming, true);
            await this._assertLastError("SET_BIT_TIMING_FD", entry);

            modeFlags |= GS_DEV_FLAG_CAN_FD;
            modeFlags |= GS_DEV_FLAG_BIT_TIMING_FD;
        }

        if (config.listenOnly) {
            modeFlags |= GS_DEV_FLAG_LISTEN_ONLY;
        }

        if (config.loopback) {
            modeFlags |= GS_DEV_FLAG_LOOP_BACK;
        }

        // 5) Optional termination request: only when the device advertises the
        //    capability (boards without a terminator GPIO do not).
        const hasTermination = !!(this.capClassic.feature & GS_DEV_FLAG_TERMINATION);
        if (hasTermination) {
            /* The vendor tool reads the state before writing its own; this also
             * keeps the panel honest if something else changed the hardware. */
            this.terminationState[entry.hostChannel] = await this._readResisterState(entry);
        }
        if (hasTermination && typeof config.termination === "boolean") {
            try {
                const term = new Uint8Array(4);
                new DataView(term.buffer).setUint32(0, config.termination ? 1 : 0, true);
                await this._ctrlOut(GS_REQ_SET_TERMINATION, entry.hostChannel, term, entry.interfaceNumber);
                await this._assertLastError("SET_TERMINATION", entry);
            } catch (e) {
                console.warn("Termination configure skipped:", e);
            }
        }

        // 6) Start bus
        await this._setDeviceMode(entry, GS_MODE_START, modeFlags);
        await this._assertLastError("MODE_START", entry);

        if (!this.startedChannels.includes(entry.hostChannel)) {
            this.startedChannels.push(entry.hostChannel);
            this.startedChannels.sort((a, b) => a - b);
        }
    }

    async resetBus(channel = 0) {
        if (!this.connected) {
            throw new Error("Device not connected");
        }

        const entry = this._channelEntry(channel);
        if (!entry) {
            return;
        }

        await this._setDeviceMode(entry, GS_MODE_RESET, 0);
        await this._assertLastError("MODE_RESET", entry);

        this.startedChannels = this.startedChannels.filter((c) => c !== entry.hostChannel);
    }

    async sendMessage(message) {
        if (!this.connected) {
            throw new Error("Device not connected");
        }

        const entry = this._channelEntry(message.channel ?? this.channel);
        if (!entry) {
            throw new Error(`Channel ${message.channel ?? this.channel} is not available`);
        }

        /* A transmission can only be accepted while the host keeps draining the
         * device (see _ensureRxLoop): never send with a dead reader. */
        this._ensureRxLoop();

        const frame = this._buildLegacyTxFrame(message, entry);
        return this._enqueueTx(async () => {
            const ep = entry.outEp & 0x7f;
            if (this.debugFrames) {
                this._trace("out", "tx", "bulk TX frame",
                    describeFrame({ ...message, channel: entry.hostChannel }),
                    `${describeFrameData(message)} · usb frame (${frame.length} B): ${hexBytes(frame)}`);
            }
            const result = await this._transferOut(ep, frame);
            if (result.status !== "ok") {
                throw new Error(`GS transferOut failed: ${result.status}`);
            }
        });
    }

    /**
     * transferOut with a watchdog.  The device can leave the OUT endpoint
     * unarmed (it only arms it while it has a frame buffer to hand back to the
     * host), and a WebUSB transfer to an unarmed endpoint simply never settles -
     * which used to look like "SEND does nothing, count never moves".  Report it
     * instead, and do not let one stuck transfer block the TX queue forever.
     */
    _transferOut(ep, data, timeoutMs = 1500) {
        return new Promise((resolve, reject) => {
            let settled = false;

            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                /* The device stopped accepting data: the usual reason is that
                 * nothing was draining its IN endpoint.  Re-arm the reader so
                 * the next attempt works instead of failing the same way. */
                this._ensureRxLoop();
                this._trace("out", "err", "bulk TX timeout",
                    `EP 0x${ep.toString(16)} after ${timeoutMs} ms`,
                    "the device stopped accepting data: it only arms the OUT endpoint while it has a free"
                    + " frame buffer, so the IN endpoint has to stay drained (reader re-armed)");
                reject(new Error(`USB transferOut to EP 0x${ep.toString(16)} did not complete within ${timeoutMs} ms (device not accepting data; IN reader re-armed, try again)`));
            }, timeoutMs);

            this.device.transferOut(ep, data).then((result) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(result);
            }, (err) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(err);
            });
        });
    }

    async startReceive() {
        if (!this.connected) {
            throw new Error("Device not connected");
        }

        this.rxRunning = true;
        this._ensureRxLoop();
    }

    async stopReceive() {
        this.stopReader();
    }

    stopReader() {
        this.rxRunning = false;
        this._rxActive = false;
        this._rxGeneration++;
    }

    /*
     * Keep exactly one reader on the vendor interface.  It must never be
     * missing: the firmware only re-arms its OUT endpoint while it has a frame
     * buffer to hand back to the host, so a host that stops reading IN makes
     * every later transferOut hang ("did not complete within ... ms") even
     * though the CAN side is fine.  Called from connect(), startReceive() and
     * before each transmission, so a reader lost to a stop/disconnect is
     * re-armed instead of silently breaking TX.
     */
    _ensureRxLoop() {
        if (!this.connected || !this.rxRunning || this._rxActive) {
            return;
        }

        const generation = ++this._rxGeneration;
        this._rxActive = true;

        this._rxLoop(generation).catch((e) => {
            if (this._rxGeneration === generation) {
                this._rxActive = false;
            }
            if (this.errorCallback) {
                this.errorCallback(e);
            }
        });
    }

    async getDeviceInfo() {
        if (!this.connected && !this.device) {
            throw new Error("Device not connected");
        }

        const first = this.channelMap[0] || { hostChannel: 0, interfaceNumber: this.interfaceNumber };
        const caps = await this._getCapabilitiesClassic(first);
        this.capClassic = caps;

        /* Standard hosts fetch the data-phase descriptor as soon as CAN FD is
         * advertised; the UI needs it (with the nominal one) to build custom
         * timing tables before any bus is started. */
        if ((caps.feature & GS_DEV_FLAG_CAN_FD) && !this.capFd) {
            try {
                this.capFd = await this._getCapabilitiesFd(first);
            } catch (e) {
                this.capFd = null;
            }
        }
        this._publishTimingInfo();

        const devVer = this._deviceConfig || null;

        return new XCanDeviceInfo({
            name: "GS_USB / Candlelight",
            firmware: devVer ? devVer.sw : "Unknown",
            hardware: devVer ? devVer.hw : "Unknown",
            serial: `${this.device?.serialNumber || "Unknown"}`,
            /* Standard gs_usb: the device config's icount + 1 channels on the
             * single vendor interface. */
            channels: this.channelMap.length || 1,
            capabilities: {
                fd: !!(caps.feature & GS_DEV_FLAG_CAN_FD),
                brs: !!(caps.feature & GS_DEV_FLAG_BIT_TIMING_FD),
                listenOnly: !!(caps.feature & GS_DEV_FLAG_LISTEN_ONLY),
                loopback: !!(caps.feature & GS_DEV_FLAG_LOOP_BACK),
                termination: !!(caps.feature & GS_DEV_FLAG_TERMINATION)
            }
        });
    }

    /* ------------------------------------------------------------------ */
    /* channel map                                                        */
    /* ------------------------------------------------------------------ */

    _discoverCandlelightInterfaces() {
        const cfg = this.device.configuration;
        if (!cfg) return [];

        const found = [];
        for (const itf of cfg.interfaces) {
            for (const alt of itf.alternates) {
                if (alt.interfaceClass !== 0xff) continue;

                const eps = alt.endpoints || [];
                const inEp = eps.find((e) => e.direction === "in" && e.type === "bulk");
                const outEp = eps.find((e) => e.direction === "out" && e.type === "bulk");
                if (!inEp || !outEp) continue;

                found.push({
                    interfaceNumber: itf.interfaceNumber,
                    inEp: inEp.endpointNumber,
                    outEp: outEp.endpointNumber,
                    inPacketSize: inEp.packetSize
                });
            }
        }
        return found;
    }

    /**
     * Flatten the device into a host channel list: the standard gs_usb layout
     * is one vendor interface carrying `icount + 1` channels, so host channel
     * n == device channel n on that interface.
     */
    _buildChannelMap(itf, icount) {
        const count = Math.max(1, (icount | 0) + 1);
        const map = [];

        for (let ch = 0; ch < count; ch++) {
            map.push({
                hostChannel: ch,
                deviceChannel: ch,
                interfaceNumber: itf.interfaceNumber,
                inEp: itf.inEp,
                outEp: itf.outEp,
                packetSize: Math.max(128, itf.inPacketSize || 64)
            });
        }

        this.channelMap = map;
        console.log(`[gsusb] interface ${itf.interfaceNumber}: ${map.length} channel(s)`);
    }

    _channelEntry(channel) {
        const ch = Number(channel);
        if (!Number.isInteger(ch) || ch < 0 || ch >= this.channelMap.length) {
            return null;
        }
        return this.channelMap[ch];
    }

    /* ------------------------------------------------------------------ */
    /* control transfers                                                  */
    /* ------------------------------------------------------------------ */

    /*
     * Decode one control transfer for the log: a short line for the column and
     * a full explanation for the hover.  Everything that is known about the
     * request is spelled out - the constant it maps to, the struct fields in
     * order (candleLight's gs_usb.h) and the raw USB fields.
     */
    _describeControl(request, value, index, bytes) {
        const clock = this.capFd?.fclk_can || this.capClassic?.fclk_can || 0;
        const length = bytes ? bytes.byteLength : 0;
        let decoded = null;

        switch (request) {
            case GS_REQ_SET_HOST_FORMAT:
                decoded = {
                    brief: `0xbeef (interface ${index})`,
                    full: "byte order marker; the Linux driver sends it before anything else",
                };
                break;
            case GS_REQ_SET_BIT_TIMING:
            case GS_REQ_SET_BIT_TIMING_FD: {
                if (length >= 20) {
                    const phase = request === GS_REQ_SET_BIT_TIMING_FD ? "data" : "arb";
                    const t = decodeBtTiming(bytes, clock);
                    decoded = {
                        brief: `CH${value + 1} ${phase} ${t.brief}`,
                        full: `${phase === "data" ? "CAN FD data phase" : "arbitration phase"}: ${t.full}`,
                    };
                }
                break;
            }
            case GS_REQ_SET_DEVICE_MODE:
                if (length >= 8) {
                    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
                    const mode = u32(dv, 0);
                    const flags = u32(dv, 4);
                    decoded = {
                        brief: `CH${value + 1} ${GS_MODES[mode] || `mode ${mode}`}`,
                        full: `mode=${mode} (GS_CAN_MODE_${(GS_MODES[mode] || mode).toUpperCase()})`
                            + ` flags=${decodeModeFlags(flags)}`,
                    };
                }
                break;
            case GS_REQ_SET_TERMINATION:
                if (length >= 4) {
                    const t = decodeTerminationState(bytes);
                    decoded = { brief: `CH${value + 1} ${t.brief}`, full: t.full };
                }
                break;
            case GS_REQ_GET_TERMINATION:
                if (length >= 4) {
                    decoded = decodeTerminationState(bytes);
                }
                break;
            case GS_REQ_GET_CAN_RESISTER_ENABLE_STATE:
                if (length >= 1) {
                    decoded = decodeResisterState(bytes[0] !== 0);
                }
                break;
            case GS_REQ_SET_CAN_RESISTER_ENABLE_STATE:
                if (length >= 1) {
                    decoded = decodeResisterState(bytes[0] !== 0);
                }
                break;
            case GS_REQ_SET_INTERFACENUMBER_ENDPOINT:
                decoded = {
                    brief: `CH${value + 1} interface ${index}`,
                    full: "endpoint hint from the vendor tool (wValue = channel, wIndex = interface);"
                        + " every interface already owns a bulk in/out pair, so it is only acknowledged",
                };
                break;
            case GS_REQ_GET_CAPABILITIES:
            case GS_REQ_GET_CAPABILITIES_FD:
                if (length >= 40) {
                    decoded = decodeBtConst(bytes, request === GS_REQ_GET_CAPABILITIES_FD && length >= 72);
                }
                break;
            case GS_REQ_GET_DEVICE_VERSION:
                if (length >= 12) {
                    decoded = decodeDeviceConfig(bytes);
                }
                break;
            case GS_REQ_GET_TIMESTAMP:
                if (length >= 4) {
                    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
                    decoded = { brief: `${u32(dv, 0)} us`, full: "device SOF timestamp in microseconds" };
                }
                break;
            case ELM_REQ_GET_LAST_ERROR:
                if (length >= 1) {
                    decoded = {
                        brief: `0x${bytes[0].toString(16).padStart(2, "0")}`,
                        full: "controller error code the firmware exposes for the vendor tool",
                    };
                }
                break;
            default:
                break;
        }

        return {
            brief: decoded ? decoded.brief : hexOrSize(bytes),
            full: [gsReqCanonical(request), decoded && decoded.full, `wValue=${value}`, `wIndex=${index}`,
                length ? `data=${hexBytes(bytes)}` : ""].filter(Boolean).join("\n"),
        };
    }

    async _ctrlIn(request, value, length, index = this.interfaceNumber) {
        const result = await this.device.controlTransferIn({
            requestType: "vendor",
            recipient: "interface",
            request,
            value,
            index
        }, length);

        if (result.status !== "ok" || !result.data) {
            throw new Error(`GS controlTransferIn failed: req=${request} status=${result.status}`);
        }

        const bytes = new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
        const decoded = this._describeControl(request, value, index, bytes);
        this._trace("in", "ctrl", gsReqName(request), decoded.brief, decoded.full);
        return result.data;
    }

    async _ctrlOut(request, value, data, index = this.interfaceNumber) {
        const result = await this.device.controlTransferOut({
            requestType: "vendor",
            recipient: "interface",
            request,
            value,
            index
        }, data);

        if (result.status !== "ok") {
            throw new Error(`GS controlTransferOut failed: req=${request} status=${result.status}`);
        }

        const bytes = data ? Uint8Array.from(data) : null;
        const decoded = this._describeControl(request, value, index, bytes);
        this._trace("out", "ctrl", gsReqName(request), decoded.brief, decoded.full);
    }

    async _assertLastError(context, entry) {
        let code = 0;
        try {
            const dv = await this._ctrlIn(ELM_REQ_GET_LAST_ERROR, entry.hostChannel, 1, entry.interfaceNumber);
            code = dv.getUint8(0);
        } catch (e) {
            // If this request itself fails, keep backward-compat behavior and continue.
            return;
        }

        // FBK_Success = 2, FBK_RetString = 1; ASCII '1'.. means failure.
        if (code === 1 || code === 2 || code === 0) {
            return;
        }
        const isAsciiErr = code >= 0x31 && code <= 0x3d;
        if (isAsciiErr) {
            throw new Error(`${context} failed with device feedback '${String.fromCharCode(code)}' (0x${code.toString(16)})`);
        }
    }

    async _getCapabilitiesClassic(entry) {
        const dv = await this._ctrlIn(GS_REQ_GET_CAPABILITIES, entry.hostChannel, GS_BT_CONST_LEN, entry.interfaceNumber);
        return {
            feature: dv.getUint32(0, true),
            fclk_can: dv.getUint32(4, true),
            time: {
                seg1_min: dv.getUint32(8, true),
                seg1_max: dv.getUint32(12, true),
                seg2_min: dv.getUint32(16, true),
                seg2_max: dv.getUint32(20, true),
                sjw_max: dv.getUint32(24, true),
                brp_min: dv.getUint32(28, true),
                brp_max: dv.getUint32(32, true),
                brp_inc: dv.getUint32(36, true)
            }
        };
    }

    async _getCapabilitiesFd(entry) {
        const dv = await this._ctrlIn(GS_REQ_GET_CAPABILITIES_FD, entry.hostChannel, GS_BT_CONST_EXT_LEN, entry.interfaceNumber);
        const parseTime = (off) => ({
            seg1_min: dv.getUint32(off + 0, true),
            seg1_max: dv.getUint32(off + 4, true),
            seg2_min: dv.getUint32(off + 8, true),
            seg2_max: dv.getUint32(off + 12, true),
            sjw_max: dv.getUint32(off + 16, true),
            brp_min: dv.getUint32(off + 20, true),
            brp_max: dv.getUint32(off + 24, true),
            brp_inc: dv.getUint32(off + 28, true)
        });
        return {
            feature: dv.getUint32(0, true),
            fclk_can: dv.getUint32(4, true),
            time_nom: parseTime(8),
            time_data: parseTime(40)
        };
    }

    async _getDeviceVersion(iface) {
        /* gs_device_config: hal_ver(3) + icount(1) + sw_bcd(4) + hw_bcd(4) = 12
         * bytes; this is a per-device request, so wValue = 1 (Linux does the
         * same) and wIndex = the interface. */
        const dv = await this._ctrlIn(
            GS_REQ_GET_DEVICE_VERSION, 1, GS_DEVICE_VERSION_LEN,
            iface ? iface.interfaceNumber : this.interfaceNumber
        );
        const swBcd = dv.getUint32(4, true);   /* offset 4: sw_version_bcd */
        const hwBcd = dv.getUint32(8, true);   /* offset 8: hw_version_bcd */
        return {
            icount: dv.getUint8(3),
            sw: this._bcdToVersion(swBcd),
            hw: this._bcdToVersion(hwBcd)
        };
    }

    _bcdToVersion(v) {
        /* The HSCanT firmware encodes both fields so the vendor's Windows tool
         * prints them correctly: sw_version = major<<16 | minor<<8 | patch
         * (0x00010008 -> 1.0.8) and hw_version = major<<24 | minor<<16 |
         * patch<<8 (0x01010000 -> 1.1.0).  Format the three bytes the value
         * actually uses, each as two hex digits. */
        const u = v >>> 0;
        const shift = (u > 0xffffff) ? 24 : 16;
        const bytes = [
            (u >>> shift) & 0xff,
            (u >>> (shift - 8)) & 0xff,
            (u >>> (shift - 16)) & 0xff
        ];
        return bytes.map((b) => b.toString(16).padStart(2, "0")).join(".");
    }

    /* GS_USB_BREQ_GET_CAN_RESISTER_ENABLE_STATE: one byte, 1 = terminated. */
    async _readResisterState(entry) {
        try {
            const data = await this._ctrlIn(
                GS_REQ_GET_CAN_RESISTER_ENABLE_STATE, entry.hostChannel, 1, entry.interfaceNumber);
            const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
            return bytes.byteLength ? bytes[0] !== 0 : null;
        } catch (err) {
            this._trace("in", "ctrl", gsReqName(GS_REQ_GET_CAN_RESISTER_ENABLE_STATE), "not supported",
                "the board does not answer the vendor resistor-state request, so the state is unknown");
            return null;
        }
    }

    async _setBitTiming(entry, timing, isFd) {
        const req = isFd ? GS_REQ_SET_BIT_TIMING_FD : GS_REQ_SET_BIT_TIMING;
        const data = new Uint8Array(20);
        const dv = new DataView(data.buffer);

        // kBitTiming: prop, seg1, seg2, sjw, brp
        dv.setUint32(0, timing.prop >>> 0, true);
        dv.setUint32(4, timing.seg1 >>> 0, true);
        dv.setUint32(8, timing.seg2 >>> 0, true);
        dv.setUint32(12, timing.sjw >>> 0, true);
        dv.setUint32(16, timing.brp >>> 0, true);

        await this._ctrlOut(req, entry.hostChannel, data, entry.interfaceNumber);
    }

    async _setDeviceMode(entry, mode, flags) {
        const data = new Uint8Array(8);
        const dv = new DataView(data.buffer);
        dv.setUint32(0, mode >>> 0, true);
        dv.setUint32(4, flags >>> 0, true);
        await this._ctrlOut(GS_REQ_SET_DEVICE_MODE, entry.hostChannel, data, entry.interfaceNumber);
    }

    /**
     * The CAN clock is fixed by the hardware and reported by the device; the
     * timing ranges are what the device says it can represent.  Both are what
     * the UI needs to generate custom timing tables.
     */
    _publishTimingInfo() {
        this.canClockHz = this.capClassic?.fclk_can || 0;
        this.timingLimits = {
            nominal: this.capClassic?.time || null,
            data: (this.capFd && this.capFd.time_data) || null
        };
    }

    /**
     * What the device would be programmed with for a preset request - pure (no
     * USB), so the page can show the resulting timing and sample point before
     * anything is started.
     */
    planPreset(config) {
        const fclk = this.canClockHz || 0;
        if (!fclk) {
            return null;
        }

        /* Report the timing *and* what it means (real bitrate, sample point) so
         * the page can show the preset's sample point. */
        const describe = (t, hz) => ({
            brp: t.brp,
            seg1: t.seg1,
            seg2: t.seg2,
            sjw: t.sjw,
            bitrateHz: hz / (t.brp * (1 + t.seg1 + t.seg2)),
            samplePoint: (1 + t.seg1) / (1 + t.seg1 + t.seg2)
        });

        const nominal = describe(
            this._calcBitTiming(fclk, config.nominalBitrate, this.timingLimits?.nominal || null, 0.8), fclk);

        let data = null;
        if (config.fdMode) {
            const fclkData = this.capFd?.fclk_can || fclk;
            const caps = (this.capFd && this.capFd.time_data) ? this.capFd.time_data : (this.timingLimits?.nominal || null);
            data = describe(
                this._calcBitTiming(fclkData, config.dataBitrate || config.nominalBitrate, caps, 0.8), fclkData);
        }

        return { nominal, data };
    }

    /**
     * Turn explicit user timing ({ brp, seg1, seg2, sjw }) into the shape the
     * device expects, refusing values the device says it cannot represent (the
     * same check the vendor's tool does against GS_USB_BREQ_BT_CONST).
     */
    _timingFromCustom(t, limits, label) {
        if (!t) {
            return null;
        }

        const brp = Number(t.brp);
        const seg1 = Number(t.seg1);
        const seg2 = Number(t.seg2);
        const sjw = Number(t.sjw ?? t.seg2);
        const lim = limits || {};

        if (![brp, seg1, seg2, sjw].every((v) => Number.isInteger(v) && v > 0)) {
            throw new Error(`${label} timing: brp/tseg1/tseg2/sjw must be positive integers`);
        }

        const problems = [];
        const range = (name, v, min, max) => {
            if (v < min || v > max) {
                problems.push(`${name} ${v} out of device range [${min}-${max}]`);
            }
        };
        range("brp", brp, lim.brp_min ?? 1, lim.brp_max ?? 1024);
        range("tseg1", seg1, lim.seg1_min ?? 1, lim.seg1_max ?? 256);
        range("tseg2", seg2, lim.seg2_min ?? 1, lim.seg2_max ?? 128);
        range("sjw", sjw, 1, lim.sjw_max ?? 128);
        const inc = Math.max(1, lim.brp_inc || 1);
        if ((brp - (lim.brp_min ?? 1)) % inc !== 0) {
            problems.push(`brp ${brp} must be a multiple of ${inc} (plus ${lim.brp_min ?? 1})`);
        }
        if (problems.length) {
            throw new Error(`${label} timing rejected by device: ${problems.join("; ")}`);
        }

        return { prop: Number(t.prop) || 0, seg1, seg2, sjw, brp };
    }

    _calcBitTiming(fclk, targetBitrate, limits, samplePoint = 0.8) {
        const lim = limits || {
            seg1_min: 1,
            seg1_max: 256,
            seg2_min: 1,
            seg2_max: 128,
            sjw_max: 128,
            brp_min: 1,
            brp_max: 512,
            brp_inc: 1
        };

        const brpInc = Math.max(1, lim.brp_inc || 1);
        let best = null;

        for (let brp = lim.brp_min; brp <= lim.brp_max; brp += brpInc) {
            const tqsFloat = fclk / (brp * targetBitrate);
            const tqs = Math.round(tqsFloat);
            if (tqs < 4 || tqs > (1 + lim.seg1_max + lim.seg2_max)) {
                continue;
            }

            for (let seg2 = lim.seg2_min; seg2 <= lim.seg2_max; seg2++) {
                const seg1 = tqs - 1 - seg2;
                if (seg1 < lim.seg1_min || seg1 > lim.seg1_max) {
                    continue;
                }

                const real = fclk / (brp * (1 + seg1 + seg2));
                const bitrateErr = Math.abs(real - targetBitrate) / targetBitrate;
                const sp = (1 + seg1) / (1 + seg1 + seg2);
                const spErr = Math.abs(sp - samplePoint);

                /*
                 * Prefer a sample point that lands on a whole multiple of 5 %.
                 * Those are the values datasheets and other tools quote, and the
                 * common case: 80 % for the arbitration phase, 80 % (or 75 %)
                 * for the data phase.  81.25 % is just as calculable but reads as
                 * noise, so it is used only when no round value is reachable at
                 * the same bitrate - 5 Mbit/s at 80 MHz is exactly that case (16
                 * time quanta per bit, where 12/16 = 75 % is the nearest round
                 * sample point to the requested 80 %).
                 *
                 * Ranked in this order: bitrate error (a bitrate that is off is
                 * never acceptable), then roundness, then closeness to the
                 * requested sample point.  In integer arithmetic, (1+seg1)/total
                 * is a multiple of 5 % exactly when 20 * (1+seg1) / total is an
                 * integer.
                 */
                const round = (((1 + seg1) * 20) % (1 + seg1 + seg2)) === 0;
                const better = !best
                    || bitrateErr < best.bitrateErr - 1e-9
                    || (Math.abs(bitrateErr - best.bitrateErr) <= 1e-9
                        && (round !== best.round ? round : spErr < best.spErr));
                if (better) {
                    best = { brp, seg1, seg2, bitrateErr, round, spErr };
                }
            }
        }

        if (!best) {
            throw new Error(`Unable to find timing for bitrate ${targetBitrate}`);
        }

        return {
            prop: 0,
            seg1: best.seg1,
            seg2: best.seg2,
            sjw: Math.max(1, Math.min(best.seg2, lim.sjw_max || best.seg2)),
            brp: best.brp
        };
    }

    /**
     * Build one host -> device frame.  `entry` also decides which channel the
     * firmware routes it to: candleLight takes the channel from the frame's
     * channel byte (USBD_GS_CAN_DataOut -> USBD_GS_CAN_GetChannel(frame.channel)),
     * so this must be the device-side channel number.
     *
     * The buffer is the full 80 byte host frame (the size the vendor tool
     * sends): firmwares only look at the first 20 (classic) or 76 (CAN FD)
     * bytes, Linux sizes its URBs exactly that way.
     */
    _buildLegacyTxFrame(message, entry) {
        const frame = new Uint8Array(GS_HOST_FRAME_LEN);
        const dv = new DataView(frame.buffer);

        const data = message.data || [];
        if (!message.fd && data.length > 8) {
            throw new Error("Classic CAN data length cannot exceed 8 bytes");
        }
        if (data.length > 64) {
            throw new Error("CAN FD data length cannot exceed 64 bytes");
        }

        let canId = (message.id >>> 0) & CAN_ID_MASK;
        if (message.extended) canId |= CAN_ID_FLAG_EXT;
        if (message.rtr) canId |= CAN_ID_FLAG_RTR;

        const dlc = message.fd ? LEN2DLC[Math.max(0, Math.min(64, data.length))] : Math.min(8, data.length);
        let flags = 0;
        if (message.fd) flags |= GS_CAN_FLAG_FD;
        if (message.brs) flags |= GS_CAN_FLAG_BRS;
        if (message.esi) flags |= GS_CAN_FLAG_ESI;

        dv.setUint32(0, this.echoCounter >>> 0, true);
        this.echoCounter = (this.echoCounter + 1) >>> 0;
        if (this.echoCounter === LEGACY_ECHO_RX) {
            this.echoCounter = 1;
        }

        dv.setUint32(4, canId >>> 0, true);
        dv.setUint8(8, dlc & 0x0f);
        dv.setUint8(9, entry ? (entry.deviceChannel & 0xff) : 0);
        dv.setUint8(10, flags & 0xff);
        dv.setUint8(11, 0);

        const copyLen = Math.min(data.length, message.fd ? 64 : 8);
        for (let i = 0; i < copyLen; i++) {
            frame[12 + i] = data[i] & 0xff;
        }

        return frame;
    }

    /**
     * Parse one device -> host frame.  On a standard gs_usb device the frame's
     * channel byte *is* the host channel number.
     */
    _parseLegacyFrame(bytes) {
        if (bytes.byteLength < 20) {
            return null;
        }
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

        const echoId = dv.getUint32(0, true);
        const rawCanId = dv.getUint32(4, true);
        const canDlc = dv.getUint8(8) & 0x0f;
        const channel = dv.getUint8(9);
        const flags = dv.getUint8(10);

        // Skip TX echo in legacy mode (echo_id != 0xFFFFFFFF)
        if (echoId !== LEGACY_ECHO_RX) {
            return null;
        }

        if (channel >= this.channelMap.length) {
            /* Frame for a channel this device does not have: ignore it. */
            return null;
        }

        // Error frame is reported via CAN ID flag in legacy mode
        if ((rawCanId & CAN_ID_FLAG_ERR) !== 0) {
            if (this.statusCallback) {
                this.statusCallback({
                    channel,
                    errorFrame: true,
                    /* Error frames are classic+timestamp when the device adds
                     * timestamps (classic_can_ts: data[8] then the u32). */
                    timestamp: (bytes.byteLength >= 24) ? dv.getUint32(20, true) : 0,
                    ...decodeErrorFrame(rawCanId, dv, bytes.byteLength)
                });
            }
            return null;
        }

        /* The device lost frames: its RX FIFO was full.  The frame that carries
         * the flag is still delivered as a normal frame below, the error is
         * reported next to it - what the kernel driver does for gs_usb. */
        if ((flags & GS_CAN_FLAG_OVERFLOW) !== 0 && this.statusCallback) {
            this.statusCallback(overflowStatus(channel));
        }

        const extended = (rawCanId & CAN_ID_FLAG_EXT) !== 0;
        const rtr = (rawCanId & CAN_ID_FLAG_RTR) !== 0;
        const id = rawCanId & CAN_ID_MASK;

        const fd = (flags & GS_CAN_FLAG_FD) !== 0;
        const brs = (flags & GS_CAN_FLAG_BRS) !== 0;
        const esi = (flags & GS_CAN_FLAG_ESI) !== 0;

        const len = fd ? DLC2LEN[canDlc] : Math.min(canDlc, 8);
        const data = [];
        for (let i = 0; i < len && (12 + i) < bytes.byteLength; i++) {
            data.push(dv.getUint8(12 + i));
        }

        let timestamp = 0;
        if (fd) {
            if (bytes.byteLength >= 80) {
                timestamp = dv.getUint32(76, true);
            }
        } else {
            if (bytes.byteLength >= 24) {
                timestamp = dv.getUint32(20, true);
            }
        }

        return new XCanMessage({
            id,
            data,
            extended,
            rtr,
            fd,
            brs,
            esi,
            timestamp,
            channel
        });
    }

    _enqueueTx(op) {
        const run = this.txQueue.then(() => op());
        this.txQueue = run.catch(() => {});
        return run;
    }

    async _rxLoop(generation) {
        const itf = this._candlelightInterfaces[0];
        if (!itf) {
            if (this._rxGeneration === generation) {
                this._rxActive = false;
            }
            return;
        }

        while (this.rxRunning && this.device && this.device.opened) {
            try {
                const ep = itf.inEp & 0x7f;
                const result = await this.device.transferIn(ep, Math.max(128, itf.inPacketSize || 64));

                if (result.status !== "ok") {
                    continue;
                }
                if (!result.data || result.data.byteLength === 0) {
                    continue;
                }

                const bytes = new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
                const msg = this._parseLegacyFrame(bytes);
                if (this.debugFrames) {
                    if (msg) {
                        this._trace("in", "rx", "bulk RX frame", describeFrame(msg),
                            `${describeFrameData(msg)} · ${bytes.byteLength} B on the wire`);
                    } else {
                        this._trace("in", "rx", "bulk RX", `${bytes.byteLength} B`,
                            `TX echo / handshake: ${hexBytes(bytes)}`);
                    }
                }
                if (msg && this.rxCallback) {
                    this.rxCallback(msg);
                }
            } catch (err) {
                /* Keep reading: an aborted transfer (device closed) ends the
                 * loop through the while condition, anything else gets reported
                 * and retried, because if nobody drains IN the firmware stops
                 * accepting OUT transfers (see connect()). */
                if (!this.rxRunning || !this.device || !this.device.opened) {
                    break;
                }
                if (this.errorCallback) {
                    this.errorCallback(err);
                }
                await new Promise((r) => setTimeout(r, 100));
            }
        }

        if (this._rxGeneration === generation) {
            this._rxActive = false;
        }
    }
}

export { GsUsbAdapter, GS_REQ_GET_CAN_RESISTER_ENABLE_STATE, GS_REQ_SET_INTERFACENUMBER_ENDPOINT };

xcanRegistry.register("gsusb", GsUsbAdapter, {
    displayName: "GS_USB / Candlelight",
    description: "Candlelight/CANable via WebUSB",
    version: "1.1.0"
});
