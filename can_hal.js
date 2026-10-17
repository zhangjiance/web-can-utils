/**
 * XCAN - Universal CAN Protocol Abstraction Layer
 * 
 * This module provides a protocol-agnostic interface for CAN communication.
 * Supports multiple CAN protocols (GS_USB today, more adapters can be
 * registered).
 */

/**
 * CAN Message Structure
 */
class XCanMessage {
    constructor({
        id = 0,
        data = [],
        extended = false,
        rtr = false,
        fd = false,
        brs = false,
        esi = false,
        timestamp = 0,
        channel = 0
    } = {}) {
        this.id = id;                    // CAN ID
        this.data = data;                // Data bytes (0-64)
        this.extended = extended;         // Extended ID (29-bit)
        this.rtr = rtr;                  // Remote Transmission Request
        this.fd = fd;                    // CAN FD
        this.brs = brs;                  // Bit Rate Switch
        this.esi = esi;                  // Error State Indicator
        this.timestamp = timestamp;       // Timestamp (us)
        this.channel = channel;           // Channel number
    }

    /**
     * Get message type string
     */
    get type() {
        if (!this.fd) {
            if (this.rtr) return this.extended ? "CAN RTR EXT" : "CAN RTR STD";
            return this.extended ? "CAN EXT" : "CAN STD";
        }
        const parts = ["CAN FD"];
        if (this.brs) parts.push("BRS");
        parts.push(this.extended ? "EXT" : "STD");
        /* ESI is a state of the received frame, so it goes last: putting it
         * between the format flags read as if it belonged to them */
        if (this.esi) parts.push("ESI");
        return parts.join(" ");
    }

    /**
     * Get data as hex string
     */
    get dataHex() {
        return this.data.map(b => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");
    }

    /**
     * Clone the message
     */
    clone() {
        return new XCanMessage({
            id: this.id,
            data: [...this.data],
            extended: this.extended,
            rtr: this.rtr,
            fd: this.fd,
            brs: this.brs,
            esi: this.esi,
            timestamp: this.timestamp,
            channel: this.channel
        });
    }
}

/**
 * CAN Bus Configuration
 */
class XCanConfig {
    constructor({
        channel = 0,
        nominalBitrate = 500000,
        dataBitrate = 2000000,
        listenOnly = false,
        fdMode = true,
        termination = false,
        customTiming = null
    } = {}) {
        this.channel = channel;
        this.nominalBitrate = nominalBitrate;
        this.dataBitrate = dataBitrate;
        this.listenOnly = listenOnly;
        this.fdMode = fdMode;
        this.termination = termination;
        this.customTiming = customTiming;
    }
}

/**
 * Device Information
 */
class XCanDeviceInfo {
    constructor({
        name = "Unknown",
        firmware = "Unknown",
        hardware = "Unknown",
        serial = "Unknown",
        channels = 1,
        capabilities = {}
    } = {}) {
        this.name = name;
        this.firmware = firmware;
        this.hardware = hardware;
        this.serial = serial;
        this.channels = channels;
        this.capabilities = capabilities;
    }
}

/**
 * Abstract CAN Interface
 * All protocol adapters must extend this class
 */
class XCanInterface {
    constructor() {
        this.connected = false;
        this.device = null;
        this.deviceInfo = new XCanDeviceInfo();
        this.rxCallback = null;
        this.statusCallback = null;
        this.errorCallback = null;

        /**
         * Debug collector, set through onDebug().  The UI uses it to show every
         * command that goes to the device (the DEBUG column); while it is null
         * the adapters do not build trace entries at all.
         */
        this.debugCallback = null;

        /**
         * Normal frames (TX, RX and echoes) are only traced when this is set.
         * Building a trace line for every frame on a busy bus is not free, so
         * it is off unless the user asks for it.
         */
        this.debugFrames = false;

        /**
         * Host channel numbers that are currently started.  Adapters that can
         * start more than one channel maintain this (gs_usb does); the UI keeps
         * its own copy so that adapters which do not implement it still work.
         */
        this.startedChannels = [];
    }

    /**
     * Request device selection (usually triggers browser USB dialog)
     * @returns {Promise<void>}
     */
    async requestDevice() {
        throw new Error("requestDevice() must be implemented by subclass");
    }

    /**
     * Connect to the device
     * @returns {Promise<void>}
     */
    async connect() {
        throw new Error("connect() must be implemented by subclass");
    }

    /**
     * Disconnect from the device
     * @returns {Promise<void>}
     */
    async disconnect() {
        throw new Error("disconnect() must be implemented by subclass");
    }

    /**
     * Initialize CAN bus with configuration
     * @param {XCanConfig} config - Bus configuration
     * @returns {Promise<void>}
     */
    async initBus(config) {
        throw new Error("initBus() must be implemented by subclass");
    }

    /**
     * Reset CAN bus
     * @param {number} channel - Channel number
     * @returns {Promise<void>}
     */
    async resetBus(channel = 0) {
        throw new Error("resetBus() must be implemented by subclass");
    }

    /**
     * Send a CAN message
     * @param {XCanMessage} message - Message to send
     * @returns {Promise<void>}
     */
    async sendMessage(message) {
        throw new Error("sendMessage() must be implemented by subclass");
    }

    /**
     * Start receiving messages
     * @returns {Promise<void>}
     */
    async startReceive() {
        throw new Error("startReceive() must be implemented by subclass");
    }

    /**
     * Stop receiving messages
     * @returns {Promise<void>}
     */
    async stopReceive() {
        throw new Error("stopReceive() must be implemented by subclass");
    }

    /**
     * Get device information
     * @returns {Promise<XCanDeviceInfo>}
     */
    async getDeviceInfo() {
        throw new Error("getDeviceInfo() must be implemented by subclass");
    }

    /**
     * Set receive callback
     * @param {Function} callback - Callback(message: XCanMessage)
     */
    onReceive(callback) {
        this.rxCallback = callback;
    }

    /**
     * Set status callback
     * @param {Function} callback - Callback(status: object)
     */
    onStatus(callback) {
        this.statusCallback = callback;
    }

    /**
     * Set error callback
     * @param {Function} callback - Callback(error: Error)
     */
    /**
     * Report one device interaction to the debug hook, if anyone is listening.
     * dir: "out" (host -> device) or "in"; kind: "ctrl" | "tx" | "rx".
     * brief is the one-line summary shown in the log, full the decode shown on
     * hover.
     */
    _trace(dir, kind, label, brief, full) {
        if (this.debugCallback) {
            this.debugCallback({ dir, kind, label, brief, full });
        }
    }

    /**
     * Collect the host <-> device traffic (see the DEBUG column).  Entries are
     * { dir: "out" | "in", kind: "ctrl" | "tx" | "rx", label, brief, full }.
     */
    onDebug(callback) {
        this.debugCallback = callback;
    }

    /** Whether to trace normal frames on top of the control transfers. */
    setDebugOptions({ frames = false } = {}) {
        this.debugFrames = !!frames;
    }

    onError(callback) {
        this.errorCallback = callback;
    }

    /**
     * Check if the adapter supports a specific feature
     * @param {string} feature - Feature name
     * @returns {boolean}
     */
    supportsFeature(feature) {
        return this.deviceInfo.capabilities[feature] || false;
    }

    /**
     * Get protocol name
     * @returns {string}
     */
    get protocolName() {
        return "Unknown";
    }
}

/**
 * Protocol Registry
 * Manages available protocol adapters
 */
class XCanProtocolRegistry {
    constructor() {
        this.protocols = new Map();
    }

    /**
     * Register a protocol adapter
     * @param {string} name - Protocol name
     * @param {class} adapterClass - Adapter class (extends XCanInterface)
     * @param {object} metadata - Protocol metadata
     */
    register(name, adapterClass, metadata = {}) {
        this.protocols.set(name, {
            class: adapterClass,
            metadata: {
                displayName: metadata.displayName || name,
                description: metadata.description || "",
                version: metadata.version || "1.0.0",
                ...metadata
            }
        });
    }

    /**
     * Get protocol adapter class
     * @param {string} name - Protocol name
     * @returns {class|null}
     */
    get(name) {
        const proto = this.protocols.get(name);
        return proto ? proto.class : null;
    }

    /**
     * Get all registered protocols
     * @returns {Array<object>}
     */
    list() {
        return Array.from(this.protocols.entries()).map(([name, proto]) => ({
            name,
            ...proto.metadata
        }));
    }

    /**
     * Create an instance of a protocol adapter
     * @param {string} name - Protocol name
     * @returns {XCanInterface|null}
     */
    create(name) {
        const AdapterClass = this.get(name);
        return AdapterClass ? new AdapterClass() : null;
    }
}

// Global protocol registry
const xcanRegistry = new XCanProtocolRegistry();

export {
    XCanMessage,
    XCanConfig,
    XCanDeviceInfo,
    XCanInterface,
    XCanProtocolRegistry,
    xcanRegistry
};

// Export classes and registry
if (typeof module !== 'undefined' && module.exports) {
    // Node.js
    module.exports = {
        XCanMessage,
        XCanConfig,
        XCanDeviceInfo,
        XCanInterface,
        XCanProtocolRegistry,
        xcanRegistry
    };
}
