// Mapper 0 (NROM) - Simplest NES mapper
// Used by games like Super Mario Bros, Donkey Kong, etc.

export class Mapper0 {
    constructor(prgBanks, chrBanks) {
        this.prgBanks = prgBanks;
        this.chrBanks = chrBanks;
    }

    cpuMapRead(addr) {
        // PRG RAM: $6000-$7FFF
        if (addr >= 0x6000 && addr < 0x8000) {
            return { addr: addr & 0x1FFF, ram: true };
        }
        // PRG ROM: $8000-$FFFF
        if (addr >= 0x8000) {
            // 16KB bank mirrored at $8000 and $C000, or 32KB at $8000
            const mask = this.prgBanks > 1 ? 0x7FFF : 0x3FFF;
            return { addr: addr & mask, ram: false };
        }
        return undefined;
    }

    cpuMapWrite(addr, data) {
        // PRG RAM: $6000-$7FFF
        if (addr >= 0x6000 && addr < 0x8000) {
            return { addr: addr & 0x1FFF, ram: true };
        }
        return undefined;
    }

    ppuMapRead(addr) {
        // Pattern tables: $0000-$1FFF
        if (addr < 0x2000) {
            return addr;
        }
        return undefined;
    }

    ppuMapWrite(addr) {
        // CHR RAM (if no CHR ROM): $0000-$1FFF
        if (addr < 0x2000 && this.chrBanks === 0) {
            return addr;
        }
        return undefined;
    }
}
