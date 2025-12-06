// NES Memory Bus - Interconnects CPU, PPU, APU, and Cartridge

export class Bus {
    constructor() {
        // 2KB internal RAM
        this.ram = new Uint8Array(2048);

        // Components (set after construction)
        this.cpu = null;
        this.ppu = null;
        this.apu = null;
        this.cartridge = null;

        // Controller state
        this.controller = [0, 0];        // Current button state (updated by input handler)
        this.controllerShift = [0, 0];   // Shift register for serial reads
        this.controllerStrobe = false;   // Strobe latch

        // DMA
        this.dmaPage = 0;
        this.dmaAddr = 0;
        this.dmaData = 0;
        this.dmaTransfer = false;
        this.dmaDummy = true;

        // System clock
        this.systemClock = 0;

        // Open bus - tracks the last value on the data bus
        this.dataBus = 0;
    }

    // Connect components
    connectCPU(cpu) { this.cpu = cpu; }
    connectPPU(ppu) { this.ppu = ppu; }
    connectAPU(apu) { this.apu = apu; }
    insertCartridge(cartridge) { this.cartridge = cartridge; }

    // CPU Read - with open bus emulation
    // The data bus retains its last value, unmapped reads return that value
    cpuRead(addr, updateDataBus = true) {
        addr &= 0xFFFF;
        let data;
        let mapped = false;

        if (addr < 0x2000) {
            // RAM (mirrored every 0x800)
            data = this.ram[addr & 0x07FF];
            mapped = true;
        } else if (addr < 0x4000) {
            // PPU Registers (mirrored every 8 bytes)
            data = this.ppu?.cpuRead(addr & 0x0007) ?? this.dataBus;
            mapped = true;
        } else if (addr === 0x4015) {
            // APU Status - bit 5 is open bus
            // Requirement 7: Reading $4015 should not update the data bus
            // Requirement 9: Bit 5 of $4015 is open bus
            const apuStatus = this.apu?.cpuRead(addr) ?? 0;
            // Preserve bit 5 from current data bus (open bus)
            data = (apuStatus & 0xDF) | (this.dataBus & 0x20);
            // Don't update data bus for $4015 reads
            return data;
        } else if (addr === 0x4016) {
            // Controller 1 read
            // Requirement 6: Upper 3 bits are open bus
            const controllerBit = (this.controllerShift[0] & 0x01);
            this.controllerShift[0] >>= 1;
            this.controllerShift[0] |= 0x80;
            // Lower 5 bits from controller, upper 3 bits from open bus
            data = (this.dataBus & 0xE0) | (controllerBit & 0x1F);
            mapped = true;
        } else if (addr === 0x4017) {
            // Controller 2 read - upper 3 bits are open bus
            const controllerBit = (this.controllerShift[1] & 0x01);
            this.controllerShift[1] >>= 1;
            this.controllerShift[1] |= 0x80;
            data = (this.dataBus & 0xE0) | (controllerBit & 0x1F);
            mapped = true;
        } else if (addr >= 0x4000 && addr < 0x4018) {
            // Other APU/IO registers - return open bus for reads
            // Most of these are write-only, reading returns open bus
            data = this.dataBus;
            mapped = true;
        } else if (addr >= 0x4018 && addr < 0x4020) {
            // CPU test mode registers - normally disabled, return open bus
            data = this.dataBus;
            mapped = true;
        } else if (addr >= 0x4020 && addr < 0x6000) {
            // Expansion ROM area ($4020-$5FFF) - usually open bus on standard hardware
            // Some cartridges might use this, but for now treat as open bus
            const cartData = this.cartridge?.cpuRead(addr);
            if (cartData !== undefined) {
                data = cartData;
            } else {
                data = this.dataBus;
            }
            mapped = true;
        } else {
            // Cartridge space ($6000-$FFFF)
            const cartData = this.cartridge?.cpuRead(addr);
            if (cartData !== undefined) {
                data = cartData;
                mapped = true;
            }
        }

        if (!mapped) {
            // Open bus - return last value on data bus
            data = this.dataBus;
        }

        // Requirement 5: Dummy reads should update the data bus
        if (updateDataBus) {
            this.dataBus = data;
        }

        return data;
    }

    // CPU Write
    // Requirement 8: Writing should always update the databus
    cpuWrite(addr, data) {
        addr &= 0xFFFF;
        data &= 0xFF;

        // Always update data bus on any write
        this.dataBus = data;

        // Cartridge has priority for mapping
        if (this.cartridge?.cpuWrite(addr, data)) return;

        if (addr < 0x2000) {
            // RAM (mirrored every 0x800)
            this.ram[addr & 0x07FF] = data;
        } else if (addr < 0x4000) {
            // PPU Registers (mirrored every 8 bytes)
            this.ppu?.cpuWrite(addr & 0x0007, data);
        } else if (addr === 0x4014) {
            // OAM DMA
            this.dmaPage = data;
            this.dmaAddr = 0;
            this.dmaTransfer = true;
        } else if (addr >= 0x4000 && addr <= 0x4013) {
            // APU Registers
            this.apu?.cpuWrite(addr, data);
        } else if (addr === 0x4015) {
            // APU Status
            this.apu?.cpuWrite(addr, data);
        } else if (addr === 0x4016) {
            // Controller strobe
            // Bit 0 controls strobe: 1 = continuously reload, 0 = latch current state
            const newStrobe = (data & 0x01) !== 0;

            // When strobe goes from 1 to 0, latch the current controller state
            if (this.controllerStrobe && !newStrobe) {
                this.controllerShift[0] = this.controller[0];
                this.controllerShift[1] = this.controller[1];
            }

            // While strobe is high, continuously reload
            if (newStrobe) {
                this.controllerShift[0] = this.controller[0];
                this.controllerShift[1] = this.controller[1];
            }

            this.controllerStrobe = newStrobe;
        } else if (addr === 0x4017) {
            // APU Frame counter
            this.apu?.cpuWrite(addr, data);
        }
    }

    // Main clock - drives CPU and PPU
    clock() {
        // PPU runs 3x faster than CPU
        this.ppu?.clock();

        if (this.systemClock % 3 === 0) {
            if (this.dmaTransfer) {
                if (this.dmaDummy) {
                    if (this.systemClock % 2 === 1) {
                        this.dmaDummy = false;
                    }
                } else {
                    if (this.systemClock % 2 === 0) {
                        this.dmaData = this.cpuRead((this.dmaPage << 8) | this.dmaAddr);
                    } else {
                        this.ppu.oam[this.dmaAddr] = this.dmaData;
                        this.dmaAddr++;
                        if (this.dmaAddr > 255) {
                            this.dmaAddr = 0;
                            this.dmaTransfer = false;
                            this.dmaDummy = true;
                        }
                    }
                }
            } else {
                this.cpu?.clock();
            }

            // APU runs at CPU rate
            this.apu?.clock();

            // Check for APU IRQs (frame counter and DMC)
            if (this.apu?.frameInterruptFlag || this.apu?.dmc.irqFlag) {
                this.cpu?.irq();
            }
        }

        this.systemClock++;
    }

    reset() {
        this.cpu?.reset();
        this.apu?.reset();
        this.systemClock = 0;
        this.dmaPage = 0;
        this.dmaAddr = 0;
        this.dmaData = 0;
        this.dmaTransfer = false;
        this.dmaDummy = true;
        this.controllerStrobe = false;
        this.controllerShift = [0, 0];
    }
}

