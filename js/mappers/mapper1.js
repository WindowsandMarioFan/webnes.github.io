// Mapper 1 (SxROM) - MMC1 chip
// Used by games like The Legend of Zelda, Metroid, Mega Man series, etc.

export class Mapper1 {
    constructor(prgBanks, chrBanks) {
        this.prgBanks = prgBanks;
        this.chrBanks = chrBanks;

        // MMC1 Internal Registers
        this.loadRegister = 0x10;  // Shift register (bit 4 is always 1)
        this.loadRegisterCounter = 0;

        // Control Register ($8000-$9FFF)
        this.ctrlRegister = 0x0C;  // Default: 32KB PRG mode, 8KB CHR mode

        // CHR Bank Registers
        this.chrReg0 = 0;  // $A000-$BFFF
        this.chrReg1 = 0;  // $C000-$DFFF

        // PRG Bank Register
        this.prgReg = 0;   // $E000-$FFFF

        // Current PRG/CHR banks
        this.prgBank0 = 0;
        this.prgBank1 = this.prgBanks - 1;
        this.chrBank0 = 0;
        this.chrBank1 = 1;

        this.updateBanks();
    }

    writeRegister(addr, data) {
        // Reset shift register on bit 7 write
        if (data & 0x80) {
            this.loadRegister = 0x10;
            this.loadRegisterCounter = 0;
            // Set control register to default when reset
            this.ctrlRegister |= 0x0C;
            this.updateBanks();
            return;
        }

        // Shift in bit 0
        this.loadRegister = ((data & 0x01) << 4) | ((this.loadRegister & 0x1F) >> 1);
        this.loadRegisterCounter++;

        // After 5 bits, write to appropriate register
        if (this.loadRegisterCounter === 5) {
            const value = this.loadRegister & 0x1F;

            if (addr >= 0x8000 && addr <= 0x9FFF) {
                // Control Register
                this.ctrlRegister = value;
            } else if (addr >= 0xA000 && addr <= 0xBFFF) {
                // CHR Bank 0
                this.chrReg0 = value;
            } else if (addr >= 0xC000 && addr <= 0xDFFF) {
                // CHR Bank 1
                this.chrReg1 = value;
            } else if (addr >= 0xE000 && addr <= 0xFFFF) {
                // PRG Bank
                this.prgReg = value & 0x0F;
            }

            this.updateBanks();
            this.loadRegister = 0x10;
            this.loadRegisterCounter = 0;
        }
    }

    updateBanks() {
        // Control register bits:
        // 0-1: Mirroring (0=1-screen, 1=1-screen, 2=Vertical, 3=Horizontal)
        // 2: PRG ROM size (0=32KB, 1=16KB)
        // 3: CHR ROM size (0=8KB, 1=4KB)
        // 4: PRG ROM bank mode (0=fixed low, 1=fixed high)

        const prgMode = (this.ctrlRegister >> 2) & 0x01;
        const chrMode = (this.ctrlRegister >> 3) & 0x01;
        const prgBankMode = (this.ctrlRegister >> 4) & 0x01;

        // Update PRG banks
        if (prgMode === 0) {
            // 32KB mode: Switch 32KB bank at $8000
            const bank = (this.prgReg >> 1) << 1;
            this.prgBank0 = bank;
            this.prgBank1 = Math.min(bank + 1, this.prgBanks - 1);
        } else {
            // 16KB mode
            if (prgBankMode === 0) {
                // Fixed low bank at $8000, switchable at $C000
                this.prgBank0 = 0;
                this.prgBank1 = Math.min(this.prgReg, this.prgBanks - 1);
            } else {
                // Switchable at $8000, fixed high at $C000
                this.prgBank0 = Math.min(this.prgReg, this.prgBanks - 1);
                this.prgBank1 = this.prgBanks - 1;
            }
        }

        // Update CHR banks
        if (chrMode === 0) {
            // 8KB mode: Both halves map to the same 8KB bank
            const bank = this.chrReg0 % Math.max(1, this.chrBanks);
            this.chrBank0 = bank;
            this.chrBank1 = bank;
        } else {
            // 4KB mode: Two independent 4KB banks
            this.chrBank0 = this.chrReg0 % Math.max(1, this.chrBanks * 2);
            this.chrBank1 = this.chrReg1 % Math.max(1, this.chrBanks * 2);
        }
    }

    cpuMapRead(addr) {
        // PRG RAM: $6000-$7FFF (8KB)
        if (addr >= 0x6000 && addr < 0x8000) {
            return { addr: addr & 0x1FFF, ram: true };
        }

        // PRG ROM: $8000-$FFFF
        if (addr >= 0x8000) {
            let bankAddr;
            if (addr < 0xC000) {
                // $8000-$BFFF maps to PRG Bank 0
                bankAddr = (this.prgBank0 * 0x4000) + (addr & 0x3FFF);
            } else {
                // $C000-$FFFF maps to PRG Bank 1
                bankAddr = (this.prgBank1 * 0x4000) + (addr & 0x3FFF);
            }
            return { addr: bankAddr, ram: false };
        }

        return undefined;
    }

    cpuMapWrite(addr, data) {
        // PRG RAM: $6000-$7FFF
        if (addr >= 0x6000 && addr < 0x8000) {
            return { addr: addr & 0x1FFF, ram: true };
        }

        // Register writes: $8000-$FFFF
        if (addr >= 0x8000) {
            this.writeRegister(addr, data);
            return undefined; // Registers don't map to CPU address space
        }

        return undefined;
    }

    ppuMapRead(addr) {
        // Pattern tables: $0000-$1FFF
        if (addr < 0x2000) {
            const chrMode = (this.ctrlRegister >> 3) & 0x01;
            let bankAddr;

            if (chrMode === 0) {
                // 8KB mode: entire $0000-$1FFF maps to selected 8KB bank
                bankAddr = (this.chrBank0 * 0x2000) + addr;
            } else {
                // 4KB mode: upper half selects which bank to use
                if (addr < 0x1000) {
                    bankAddr = (this.chrBank0 * 0x1000) + addr;
                } else {
                    bankAddr = (this.chrBank1 * 0x1000) + (addr - 0x1000);
                }
            }

            return bankAddr;
        }

        return undefined;
    }

    ppuMapWrite(addr) {
        // CHR RAM (if no CHR ROM): $0000-$1FFF
        if (addr < 0x2000 && this.chrBanks === 0) {
            return addr;
        }

        // CHR ROM is read-only
        return undefined;
    }
}
