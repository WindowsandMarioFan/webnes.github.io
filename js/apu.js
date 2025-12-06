// NES APU (Audio Processing Unit) Emulator
// 5 channels: 2 pulse, 1 triangle, 1 noise, 1 DMC (DPCM samples)
// Each channel has variable-rate timer, waveform generator, and modulators
// Outputs combined using non-linear mixing

export class APU {
    constructor(bus) {
        this.bus = bus;

        // Audio context (Web Audio API)
        this.audioCtx = null;
        this.scriptProcessor = null;
        this.sampleRate = 44100;
        this.bufferSize = 2048;
        this.enabled = false;

        // Sample output buffer
        this.sampleBuffer = [];
        this.cpuCyclesPerSample = 1789773 / this.sampleRate;
        this.sampleCycleCounter = 0;

        // Frame counter - drives envelope, length counter, sweep
        this.frameCounterCycle = 0;
        this.frameCounterMode = 0;      // 0 = 4-step, 1 = 5-step
        this.frameInterruptFlag = false;
        this.frameInterruptInhibit = false;
        this.frameCounterResetDelay = 0;
        this.pendingFrameIrqClear = false;  // Delayed clearing for get/put timing

        // CPU cycle counter (for half-rate clocking)
        this.cpuCycle = 0;

        // ===== PULSE CHANNELS (2) =====
        this.pulse = [this.createPulseChannel(), this.createPulseChannel()];

        // ===== TRIANGLE CHANNEL =====
        this.triangle = {
            // Timer (clocks waveform)
            timerPeriod: 0,
            timerValue: 0,

            // Waveform generator
            sequencerStep: 0,

            // Length counter (silences after time)
            lengthCounterHalt: false,
            lengthCounter: 0,

            // Linear counter (additional duration control)
            linearCounterReload: 0,
            linearCounter: 0,
            linearCounterReloadFlag: false,

            enabled: false
        };

        // ===== NOISE CHANNEL =====
        this.noise = {
            // Timer
            timerPeriod: 0,
            timerValue: 0,

            // Shift register (generates pseudo-random noise)
            shiftRegister: 1,
            mode: false,  // false = 32767 steps, true = 93 steps

            // Length counter
            lengthCounterHalt: false,
            lengthCounter: 0,

            // Envelope generator (volume control)
            envelopeStart: false,
            envelopeLoop: false,
            envelopeConstant: false,
            envelopeDividerPeriod: 0,
            envelopeDivider: 0,
            envelopeDecay: 0,

            enabled: false
        };

        // ===== DMC CHANNEL (Delta Modulation) =====
        this.dmc = {
            // Timer
            timerPeriod: 428, // Default rate index 0
            timerValue: 0,

            // Memory reader
            sampleAddress: 0xC000,
            sampleLength: 1,    // (0 << 4) | 1 = 1 byte minimum
            currentAddress: 0xC000,
            bytesRemaining: 0,

            // Sample buffer
            sampleBuffer: 0,
            sampleBufferEmpty: true,

            // Output unit
            shiftRegister: 0,
            bitsRemaining: 8,   // Start with full 8 bits (fixes FAIL 1)
            outputLevel: 0,
            silenceFlag: true,

            // Flags
            irqEnabled: false,
            irqFlag: false,
            loop: false,

            enabled: false
        };

        // Lookup tables
        this.initLookupTables();
    }

    createPulseChannel() {
        return {
            // Timer (clocks waveform)
            timerPeriod: 0,
            timerValue: 0,

            // Waveform generator
            dutyMode: 0,        // 0-3: 12.5%, 25%, 50%, 75%
            sequencerStep: 0,

            // Length counter (silences channel after time)
            lengthCounterHalt: false,
            lengthCounter: 0,

            // Envelope generator (volume modulator)
            envelopeStart: false,
            envelopeLoop: false,
            envelopeConstant: false,
            envelopeDividerPeriod: 0,
            envelopeDivider: 0,
            envelopeDecay: 0,

            // Sweep unit (pitch modulator)
            sweepEnabled: false,
            sweepDividerPeriod: 0,
            sweepNegate: false,
            sweepShift: 0,
            sweepDivider: 0,
            sweepReload: false,

            enabled: false
        };
    }

    initLookupTables() {
        // Length counter lookup table
        this.lengthTable = [
            10, 254, 20, 2, 40, 4, 80, 6, 160, 8, 60, 10, 14, 12, 26, 14,
            12, 16, 24, 18, 48, 20, 96, 22, 192, 24, 72, 26, 16, 28, 32, 30
        ];

        // Duty cycle waveforms (8 steps each)
        this.dutyTable = [
            [0, 1, 0, 0, 0, 0, 0, 0], // 12.5%
            [0, 1, 1, 0, 0, 0, 0, 0], // 25%
            [0, 1, 1, 1, 1, 0, 0, 0], // 50%
            [1, 0, 0, 1, 1, 1, 1, 1]  // 75% (inverted 25%)
        ];

        // Triangle waveform (32 steps)
        this.triangleTable = [
            15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0,
            0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15
        ];

        // Noise timer periods (NTSC)
        this.noiseTable = [
            4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068
        ];

        // DMC rate table (NTSC)
        this.dmcRateTable = [
            428, 380, 340, 320, 286, 254, 226, 214, 190, 160, 142, 128, 106, 84, 72, 54
        ];

        // Non-linear mixing lookup tables
        this.pulseTable = new Float32Array(31);
        this.tndTable = new Float32Array(203);

        for (let i = 0; i < 31; i++) {
            this.pulseTable[i] = i === 0 ? 0 : 95.52 / (8128.0 / i + 100);
        }
        for (let i = 0; i < 203; i++) {
            this.tndTable[i] = i === 0 ? 0 : 163.67 / (24329.0 / i + 100);
        }
    }

    // ===== AUDIO INITIALIZATION =====
    init() {
        if (this.audioCtx) return;

        try {
            this.audioCtx = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: this.sampleRate
            });

            this.scriptProcessor = this.audioCtx.createScriptProcessor(this.bufferSize, 0, 1);
            this.scriptProcessor.onaudioprocess = (e) => this.audioProcess(e);
            this.scriptProcessor.connect(this.audioCtx.destination);

            this.enabled = true;
            console.log('APU audio initialized');
        } catch (err) {
            console.error('Failed to initialize audio:', err);
        }
    }

    audioProcess(e) {
        const output = e.outputBuffer.getChannelData(0);
        for (let i = 0; i < output.length; i++) {
            output[i] = this.sampleBuffer.length > 0 ? this.sampleBuffer.shift() : 0;
        }
    }

    // ===== REGISTER WRITES =====
    cpuWrite(addr, data) {
        switch (addr) {
            // Pulse 1: $4000-$4003
            case 0x4000: this.writePulseDutyEnvelope(0, data); break;
            case 0x4001: this.writePulseSweep(0, data); break;
            case 0x4002: this.writePulseTimerLow(0, data); break;
            case 0x4003: this.writePulseLengthTimerHigh(0, data); break;

            // Pulse 2: $4004-$4007
            case 0x4004: this.writePulseDutyEnvelope(1, data); break;
            case 0x4005: this.writePulseSweep(1, data); break;
            case 0x4006: this.writePulseTimerLow(1, data); break;
            case 0x4007: this.writePulseLengthTimerHigh(1, data); break;

            // Triangle: $4008-$400B
            case 0x4008: this.writeTriangleLinearCounter(data); break;
            case 0x400A: this.writeTriangleTimerLow(data); break;
            case 0x400B: this.writeTriangleLengthTimerHigh(data); break;

            // Noise: $400C-$400F
            case 0x400C: this.writeNoiseEnvelope(data); break;
            case 0x400E: this.writeNoiseMode(data); break;
            case 0x400F: this.writeNoiseLength(data); break;

            // DMC: $4010-$4013
            case 0x4010: this.writeDmcFlags(data); break;
            case 0x4011: this.writeDmcDirectLoad(data); break;
            case 0x4012: this.writeDmcSampleAddress(data); break;
            case 0x4013: this.writeDmcSampleLength(data); break;

            // Status: $4015
            case 0x4015: this.writeStatus(data); break;

            // Frame counter: $4017
            case 0x4017: this.writeFrameCounter(data); break;
        }
    }

    cpuRead(addr) {
        if (addr === 0x4015) {
            return this.readStatus();
        }
        return 0;
    }

    // ===== PULSE CHANNEL REGISTERS =====
    writePulseDutyEnvelope(ch, data) {
        const p = this.pulse[ch];
        p.dutyMode = (data >> 6) & 0x03;
        p.lengthCounterHalt = (data & 0x20) !== 0;
        p.envelopeLoop = (data & 0x20) !== 0;
        p.envelopeConstant = (data & 0x10) !== 0;
        p.envelopeDividerPeriod = data & 0x0F;
    }

    writePulseSweep(ch, data) {
        const p = this.pulse[ch];
        p.sweepEnabled = (data & 0x80) !== 0;
        p.sweepDividerPeriod = (data >> 4) & 0x07;
        p.sweepNegate = (data & 0x08) !== 0;
        p.sweepShift = data & 0x07;
        p.sweepReload = true;
    }

    writePulseTimerLow(ch, data) {
        this.pulse[ch].timerPeriod = (this.pulse[ch].timerPeriod & 0x700) | data;
    }

    writePulseLengthTimerHigh(ch, data) {
        const p = this.pulse[ch];
        p.timerPeriod = (p.timerPeriod & 0x00FF) | ((data & 0x07) << 8);
        if (p.enabled) {
            p.lengthCounter = this.lengthTable[(data >> 3) & 0x1F];
        }
        p.sequencerStep = 0;
        p.envelopeStart = true;
    }

    // ===== TRIANGLE CHANNEL REGISTERS =====
    writeTriangleLinearCounter(data) {
        this.triangle.lengthCounterHalt = (data & 0x80) !== 0;
        this.triangle.linearCounterReload = data & 0x7F;
    }

    writeTriangleTimerLow(data) {
        this.triangle.timerPeriod = (this.triangle.timerPeriod & 0x700) | data;
    }

    writeTriangleLengthTimerHigh(data) {
        this.triangle.timerPeriod = (this.triangle.timerPeriod & 0x00FF) | ((data & 0x07) << 8);
        if (this.triangle.enabled) {
            this.triangle.lengthCounter = this.lengthTable[(data >> 3) & 0x1F];
        }
        this.triangle.linearCounterReloadFlag = true;
    }

    // ===== NOISE CHANNEL REGISTERS =====
    writeNoiseEnvelope(data) {
        this.noise.lengthCounterHalt = (data & 0x20) !== 0;
        this.noise.envelopeLoop = (data & 0x20) !== 0;
        this.noise.envelopeConstant = (data & 0x10) !== 0;
        this.noise.envelopeDividerPeriod = data & 0x0F;
    }

    writeNoiseMode(data) {
        this.noise.mode = (data & 0x80) !== 0;
        this.noise.timerPeriod = this.noiseTable[data & 0x0F];
    }

    writeNoiseLength(data) {
        if (this.noise.enabled) {
            this.noise.lengthCounter = this.lengthTable[(data >> 3) & 0x1F];
        }
        this.noise.envelopeStart = true;
    }

    // ===== DMC CHANNEL REGISTERS =====
    // $4010: Flags and Rate
    writeDmcFlags(data) {
        const wasIrqEnabled = this.dmc.irqEnabled;
        this.dmc.irqEnabled = (data & 0x80) !== 0;
        this.dmc.loop = (data & 0x40) !== 0;
        this.dmc.timerPeriod = this.dmcRateTable[data & 0x0F];

        // Requirement B: Disabling IRQ should clear IRQ flag
        if (!this.dmc.irqEnabled) {
            this.dmc.irqFlag = false;
        }
    }

    // $4011: Direct Load
    writeDmcDirectLoad(data) {
        this.dmc.outputLevel = data & 0x7F;
    }

    // $4012: Sample Address
    writeDmcSampleAddress(data) {
        // Sample address = %11AAAAAA.AA000000 = $C000 + (A * 64)
        this.dmc.sampleAddress = 0xC000 | (data << 6);
    }

    // $4013: Sample Length
    // Requirement 6: Writing to $4013 shouldn't change the sample length of currently playing sample
    // Requirement H: Writing $00 results in 1-byte sample
    writeDmcSampleLength(data) {
        // Sample length = %LLLL.LLLL0001 = (L * 16) + 1
        // This only sets the reload value, not the current bytes remaining
        this.dmc.sampleLength = (data << 4) | 1;
    }

    // ===== STATUS REGISTER =====
    // $4015 Write
    writeStatus(data) {
        // Enable/disable pulse, triangle, noise channels
        this.pulse[0].enabled = (data & 0x01) !== 0;
        this.pulse[1].enabled = (data & 0x02) !== 0;
        this.triangle.enabled = (data & 0x04) !== 0;
        this.noise.enabled = (data & 0x08) !== 0;
        const dmcEnable = (data & 0x10) !== 0;

        // Silence disabled channels (set length counter to 0)
        if (!this.pulse[0].enabled) this.pulse[0].lengthCounter = 0;
        if (!this.pulse[1].enabled) this.pulse[1].lengthCounter = 0;
        if (!this.triangle.enabled) this.triangle.lengthCounter = 0;
        if (!this.noise.enabled) this.noise.lengthCounter = 0;

        // Requirement A: Writing to $4015 should clear DMC IRQ flag
        this.dmc.irqFlag = false;

        // DMC handling
        if (!dmcEnable) {
            // Requirement 5: Writing $00 to $4015 should immediately stop the sample
            this.dmc.bytesRemaining = 0;
        } else {
            // Requirement 3: Writing $10 to $4015 should start playing a new sample if previous ended
            // Requirement 4: Writing $10 while playing shouldn't affect anything
            if (this.dmc.bytesRemaining === 0) {
                // Requirement 2: Restarting DMC should reload sample length
                this.dmc.currentAddress = this.dmc.sampleAddress;
                this.dmc.bytesRemaining = this.dmc.sampleLength;

                // Requirement I: Fill buffer immediately if empty
                if (this.dmc.sampleBufferEmpty && this.dmc.bytesRemaining > 0) {
                    this.dmc.sampleBuffer = this.bus.cpuRead(this.dmc.currentAddress);
                    this.dmc.sampleBufferEmpty = false;
                    this.dmc.currentAddress++;
                    if (this.dmc.currentAddress > 0xFFFF) {
                        this.dmc.currentAddress = 0x8000;
                    }
                    this.dmc.bytesRemaining--;
                    // Don't check for sample end here, let normal clocking handle it
                }
            }
        }

        this.dmc.enabled = dmcEnable;
    }

    // $4015 Read
    readStatus() {
        let status = 0;
        if (this.pulse[0].lengthCounter > 0) status |= 0x01;
        if (this.pulse[1].lengthCounter > 0) status |= 0x02;
        if (this.triangle.lengthCounter > 0) status |= 0x04;
        if (this.noise.lengthCounter > 0) status |= 0x08;

        // Requirement 1: Bit 4 set when DMC is playing (bytesRemaining > 0)
        if (this.dmc.bytesRemaining > 0) status |= 0x10;

        if (this.frameInterruptFlag) status |= 0x40;
        if (this.dmc.irqFlag) status |= 0x80;

        // Requirement 5: Reading clears frame IRQ flag (immediate)
        this.frameInterruptFlag = false;

        return status;
    }

    // ===== FRAME COUNTER =====
    // Writing $4017 controls frame counter mode and IRQ inhibit
    writeFrameCounter(data) {
        const prevMode = this.frameCounterMode;
        this.frameCounterMode = (data >> 7) & 0x01;
        this.frameInterruptInhibit = (data & 0x40) !== 0;

        // Requirement 9: Disabling IRQ should clear the IRQ flag
        if (this.frameInterruptInhibit) {
            this.frameInterruptFlag = false;
        }

        // Requirement 8: Changing to 5-step mode does NOT clear flag if already set
        // (only inhibit bit clears it, not mode change)

        // Reset timing based on odd/even CPU cycle
        // Requirements A-D: write on odd vs even cycle affects timing
        if (this.cpuCycle % 2 === 1) {
            // Odd cycle: reset happens after 4 CPU cycles
            this.frameCounterResetDelay = 4;
        } else {
            // Even cycle: reset happens after 3 CPU cycles  
            this.frameCounterResetDelay = 3;
        }

        // If 5-step mode, clock immediately
        if (this.frameCounterMode === 1) {
            this.clockQuarterFrame();
            this.clockHalfFrame();
        }
    }

    // ===== MAIN CLOCK (called every CPU cycle) =====
    clock() {
        // Handle frame counter reset delay
        if (this.frameCounterResetDelay > 0) {
            this.frameCounterResetDelay--;
            if (this.frameCounterResetDelay === 0) {
                this.frameCounterCycle = 0;
            }
        }

        // Triangle timer clocks at CPU rate (every cycle)
        this.clockTriangleTimer();

        // Pulse, noise, and DMC timers clock at HALF CPU rate (every 2 cycles)
        // This is known as the APU cycle
        if (this.cpuCycle % 2 === 0) {
            this.clockPulseTimers();
            this.clockNoiseTimer();
            this.clockDmcTimer();
        }

        // Frame counter clocks at CPU rate
        this.clockFrameCounter();

        // Increment CPU cycle counter
        this.cpuCycle++;

        // Generate audio sample
        this.sampleCycleCounter++;
        if (this.sampleCycleCounter >= this.cpuCyclesPerSample) {
            this.sampleCycleCounter -= this.cpuCyclesPerSample;
            this.outputSample();
        }
    }

    // ===== TIMER CLOCKING =====
    clockPulseTimers() {
        for (let i = 0; i < 2; i++) {
            const p = this.pulse[i];
            if (p.timerValue === 0) {
                p.timerValue = p.timerPeriod;
                p.sequencerStep = (p.sequencerStep + 1) & 0x07;
            } else {
                p.timerValue--;
            }
        }
    }

    clockTriangleTimer() {
        if (this.triangle.timerValue === 0) {
            this.triangle.timerValue = this.triangle.timerPeriod;
            // Only step if length counter and linear counter are non-zero
            if (this.triangle.lengthCounter > 0 && this.triangle.linearCounter > 0) {
                this.triangle.sequencerStep = (this.triangle.sequencerStep + 1) & 0x1F;
            }
        } else {
            this.triangle.timerValue--;
        }
    }

    clockNoiseTimer() {
        if (this.noise.timerValue === 0) {
            this.noise.timerValue = this.noise.timerPeriod;

            // Clock shift register
            const bit = this.noise.mode ? 6 : 1;
            const feedback = (this.noise.shiftRegister & 0x01) ^
                ((this.noise.shiftRegister >> bit) & 0x01);
            this.noise.shiftRegister = (this.noise.shiftRegister >> 1) | (feedback << 14);
        } else {
            this.noise.timerValue--;
        }
    }

    clockDmcTimer() {
        // DMC timer always runs (output level is always output to mixer)
        // Memory reader operates independently

        // Clock the timer
        if (this.dmc.timerValue === 0) {
            this.dmc.timerValue = this.dmc.timerPeriod;

            // Output unit clocks on every timer tick
            if (!this.dmc.silenceFlag) {
                // Bit 0 of shift register determines delta
                if (this.dmc.shiftRegister & 0x01) {
                    // Add 2, but only if output level is <= 125
                    if (this.dmc.outputLevel <= 125) {
                        this.dmc.outputLevel += 2;
                    }
                } else {
                    // Subtract 2, but only if output level is >= 2
                    if (this.dmc.outputLevel >= 2) {
                        this.dmc.outputLevel -= 2;
                    }
                }
            }

            // Always shift, even if silenced
            this.dmc.shiftRegister >>= 1;

            // Decrement bits remaining counter
            this.dmc.bitsRemaining--;
            if (this.dmc.bitsRemaining === 0) {
                // Output cycle ends, start new cycle
                this.dmc.bitsRemaining = 8;

                if (this.dmc.sampleBufferEmpty) {
                    // No sample available, set silence flag
                    this.dmc.silenceFlag = true;
                } else {
                    // Load sample buffer into shift register
                    this.dmc.silenceFlag = false;
                    this.dmc.shiftRegister = this.dmc.sampleBuffer;
                    this.dmc.sampleBufferEmpty = true;
                }
            }
        } else {
            this.dmc.timerValue--;
        }

        // Memory reader - fills sample buffer when empty and bytes remain
        // Requirement I: One-byte buffer that's filled immediately if empty
        if (this.dmc.sampleBufferEmpty && this.dmc.bytesRemaining > 0) {
            // Fetch sample from memory
            // (In real hardware, this stalls CPU for 1-4 cycles - we skip that complexity)
            this.dmc.sampleBuffer = this.bus.cpuRead(this.dmc.currentAddress);
            this.dmc.sampleBufferEmpty = false;

            // Requirement K: Address should overflow to $8000 instead of $0000
            this.dmc.currentAddress++;
            if (this.dmc.currentAddress > 0xFFFF) {
                this.dmc.currentAddress = 0x8000;
            }

            // Decrement bytes remaining
            this.dmc.bytesRemaining--;

            if (this.dmc.bytesRemaining === 0) {
                // Sample ended
                if (this.dmc.loop) {
                    // Requirement C: Looping samples should loop
                    // Requirement G: Looping sample reloads sample length from $4013 every time
                    this.dmc.currentAddress = this.dmc.sampleAddress;
                    this.dmc.bytesRemaining = this.dmc.sampleLength;
                    // Requirement D: Looping samples should NOT set IRQ when they loop
                } else {
                    // Non-looping sample ended
                    // Requirement 7: IRQ flag should not be set when disabled
                    // Requirement 8: IRQ flag should be set when enabled and sample ends
                    if (this.dmc.irqEnabled) {
                        this.dmc.irqFlag = true;
                    }
                }
            }
        }
    }

    // ===== FRAME COUNTER CLOCKING =====
    // Requirements I-L: IRQ flag set at CPU cycles 29828-29830 after reset
    // The frame counter is counted in CPU cycles, not APU cycles
    clockFrameCounter() {
        this.frameCounterCycle++;

        if (this.frameCounterMode === 0) {
            // Mode 0: 4-Step Sequence (NTSC) - uses CPU cycles
            // Quarter frame at: 7457, 14913, 22371, 29829
            // Half frame at: 14913, 29829
            // IRQ set at: 29828, 29829, 29830 (3 cycles)
            // 
            // Requirements J-L: 
            // - Flag should NOT be set at 29827
            // - Flag SHOULD be set at 29828, 29829 (even if inhibited, flag still set internally)
            // - Flag should NOT be set at 29830 if inhibited
            // Requirement M: IRQ only fires if not inhibited

            switch (this.frameCounterCycle) {
                case 7457:
                    this.clockQuarterFrame();
                    break;
                case 14913:
                    this.clockQuarterFrame();
                    this.clockHalfFrame();
                    break;
                case 22371:
                    this.clockQuarterFrame();
                    break;
                case 29828:
                    // Set IRQ flag if not inhibited
                    if (!this.frameInterruptInhibit) {
                        this.frameInterruptFlag = true;
                    }
                    break;
                case 29829:
                    this.clockQuarterFrame();
                    this.clockHalfFrame();
                    if (!this.frameInterruptInhibit) {
                        this.frameInterruptFlag = true;
                    }
                    break;
                case 29830:
                    if (!this.frameInterruptInhibit) {
                        this.frameInterruptFlag = true;
                    }
                    // Reset counter
                    this.frameCounterCycle = 0;
                    break;
            }
        } else {
            // Mode 1: 5-Step Sequence (NTSC)
            // Requirements 3-4: IRQ flag is NEVER set in 5-step mode
            // Quarter frame at: 7457, 14913, 22371, 37281
            // Half frame at: 14913, 37281
            switch (this.frameCounterCycle) {
                case 7457:
                    this.clockQuarterFrame();
                    break;
                case 14913:
                    this.clockQuarterFrame();
                    this.clockHalfFrame();
                    break;
                case 22371:
                    this.clockQuarterFrame();
                    break;
                case 29829:
                    // Nothing in 5-step mode - no IRQ ever
                    break;
                case 37281:
                    this.clockQuarterFrame();
                    this.clockHalfFrame();
                    this.frameCounterCycle = 0;
                    break;
            }
        }
    }

    // Quarter frame: clocks envelopes and triangle linear counter
    clockQuarterFrame() {
        // Envelope clocking for pulse and noise
        this.clockEnvelope(this.pulse[0]);
        this.clockEnvelope(this.pulse[1]);
        this.clockEnvelope(this.noise);

        // Triangle linear counter
        if (this.triangle.linearCounterReloadFlag) {
            this.triangle.linearCounter = this.triangle.linearCounterReload;
        } else if (this.triangle.linearCounter > 0) {
            this.triangle.linearCounter--;
        }

        if (!this.triangle.lengthCounterHalt) {
            this.triangle.linearCounterReloadFlag = false;
        }
    }

    // Half frame: clocks length counters and sweep units
    clockHalfFrame() {
        // Length counters
        this.clockLengthCounter(this.pulse[0]);
        this.clockLengthCounter(this.pulse[1]);
        this.clockLengthCounter(this.triangle);
        this.clockLengthCounter(this.noise);

        // Sweep units (pulse channels only)
        this.clockSweep(0);
        this.clockSweep(1);
    }

    clockEnvelope(channel) {
        if (channel.envelopeStart) {
            channel.envelopeStart = false;
            channel.envelopeDecay = 15;
            channel.envelopeDivider = channel.envelopeDividerPeriod;
        } else {
            if (channel.envelopeDivider === 0) {
                channel.envelopeDivider = channel.envelopeDividerPeriod;
                if (channel.envelopeDecay > 0) {
                    channel.envelopeDecay--;
                } else if (channel.envelopeLoop) {
                    channel.envelopeDecay = 15;
                }
            } else {
                channel.envelopeDivider--;
            }
        }
    }

    clockLengthCounter(channel) {
        if (!channel.lengthCounterHalt && channel.lengthCounter > 0) {
            channel.lengthCounter--;
        }
    }

    clockSweep(ch) {
        const p = this.pulse[ch];

        // Calculate target period
        let changeAmount = p.timerPeriod >> p.sweepShift;
        if (p.sweepNegate) {
            changeAmount = -changeAmount;
            if (ch === 0) changeAmount--; // Pulse 1 uses one's complement
        }
        const targetPeriod = p.timerPeriod + changeAmount;

        // Check if sweep would mute the channel
        const muting = p.timerPeriod < 8 || targetPeriod > 0x7FF;

        // Update period if sweep is enabled and not muting
        if (p.sweepDivider === 0 && p.sweepEnabled && p.sweepShift > 0 && !muting) {
            p.timerPeriod = targetPeriod & 0x7FF;
        }

        // Clock divider
        if (p.sweepDivider === 0 || p.sweepReload) {
            p.sweepDivider = p.sweepDividerPeriod;
            p.sweepReload = false;
        } else {
            p.sweepDivider--;
        }
    }

    // ===== OUTPUT =====
    // Channels output waveforms when their length counters are non-zero
    // Pulse has additional silencing: period < 8, or sweep target > 0x7FF
    // Triangle requires both length counter AND linear counter non-zero
    // DMC always outputs its counter value regardless of enable bit

    getPulseOutput(ch) {
        const p = this.pulse[ch];

        // Silenced if length counter is zero
        if (p.lengthCounter === 0) return 0;

        // Silenced if timer period is less than 8 (frequency too high)
        if (p.timerPeriod < 8) return 0;

        // Silenced if sweep would push period past maximum
        // This muting happens even if sweep is disabled
        let changeAmount = p.timerPeriod >> p.sweepShift;
        if (p.sweepNegate) {
            changeAmount = -changeAmount;
            if (ch === 0) changeAmount--; // Pulse 1 uses one's complement
        }
        const targetPeriod = p.timerPeriod + changeAmount;
        if (targetPeriod > 0x7FF) return 0;

        // Get waveform output (duty cycle determines if high or low)
        const duty = this.dutyTable[p.dutyMode][p.sequencerStep];
        if (duty === 0) return 0;

        // Return volume (constant or from envelope)
        return p.envelopeConstant ? p.envelopeDividerPeriod : p.envelopeDecay;
    }

    getTriangleOutput() {
        // Silenced if length counter OR linear counter is zero
        if (this.triangle.lengthCounter === 0) return 0;
        if (this.triangle.linearCounter === 0) return 0;

        // Very low periods produce ultrasonic frequencies
        // Still output but effectively inaudible (some emulators mute this)
        if (this.triangle.timerPeriod < 2) return 7; // Return middle value to avoid popping

        return this.triangleTable[this.triangle.sequencerStep];
    }

    getNoiseOutput() {
        // Silenced if length counter is zero
        if (this.noise.lengthCounter === 0) return 0;

        // Shift register bit 0 determines output
        // When bit 0 is 1, the output is silence (0)
        if (this.noise.shiftRegister & 0x01) return 0;

        // Return volume (constant or from envelope)
        return this.noise.envelopeConstant ? this.noise.envelopeDividerPeriod : this.noise.envelopeDecay;
    }

    getDmcOutput() {
        // DMC ALWAYS outputs its counter value regardless of enable bit
        // The enable bit only controls automatic sample playback
        return this.dmc.outputLevel;
    }

    // Non-linear mixing (matches NES hardware)
    outputSample() {
        const pulse1 = this.getPulseOutput(0);
        const pulse2 = this.getPulseOutput(1);
        const triangle = this.getTriangleOutput();
        const noise = this.getNoiseOutput();
        const dmc = this.getDmcOutput();

        // Use lookup tables for non-linear mixing
        const pulseOut = this.pulseTable[pulse1 + pulse2];
        const tndOut = this.tndTable[3 * triangle + 2 * noise + dmc];

        const sample = pulseOut + tndOut;

        // Limit buffer size to prevent memory issues
        if (this.sampleBuffer.length < this.bufferSize * 3) {
            this.sampleBuffer.push(sample);
        }
    }

    reset() {
        this.writeStatus(0);
        this.frameCounterCycle = 0;
        this.sampleBuffer = [];
        this.sampleCycleCounter = 0;
        this.cpuCycle = 0;

        // Reset DMC output level
        this.dmc.outputLevel = 0;
    }
}
