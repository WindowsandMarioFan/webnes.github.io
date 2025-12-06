// NES Cartridge - ROM loading and mapper support

import { Mapper0 } from './mappers/mapper0.js';
import { Mapper1 } from './mappers/mapper1.js';

export class Cartridge {
    constructor(romData) {
        this.prgRom = null;
        this.chrRom = null;
        this.prgRam = new Uint8Array(8192);
        this.mapper = null;
        this.mapperId = 0;
        this.mirror = 0; // 0 = Horizontal, 1 = Vertical
        this.valid = false;

        this.parseRom(romData);
    }

    parseRom(data) {
        if (!data || data.length < 16) {
            console.error('Invalid ROM: too small');
            return;
        }

        // Check iNES header (starts with "NES" + 0x1A)
        if (data[0] !== 0x4E || data[1] !== 0x45 || data[2] !== 0x53 || data[3] !== 0x1A) {
            console.error('Invalid ROM: not an iNES file');
            return;
        }

        const prgBanks = data[4];  // 16KB units
        const chrBanks = data[5];  // 8KB units
        const flags6 = data[6];
        const flags7 = data[7];

        // Mapper ID from flags
        this.mapperId = ((flags7 & 0xF0) | ((flags6 & 0xF0) >> 4));

        // Mirroring
        this.mirror = (flags6 & 0x01) ? 1 : 0;  // 0 = H, 1 = V

        // Check for trainer (512 bytes after header)
        const hasTrainer = (flags6 & 0x04) !== 0;
        let offset = 16 + (hasTrainer ? 512 : 0);

        // Extract PRG ROM
        const prgSize = prgBanks * 16384;
        this.prgRom = new Uint8Array(data.slice(offset, offset + prgSize));
        offset += prgSize;

        // Extract CHR ROM (or allocate CHR RAM if none)
        if (chrBanks > 0) {
            const chrSize = chrBanks * 8192;
            this.chrRom = new Uint8Array(data.slice(offset, offset + chrSize));
        } else {
            this.chrRom = new Uint8Array(8192); // CHR RAM
        }

        // Create mapper
        switch (this.mapperId) {
            case 0:
                this.mapper = new Mapper0(prgBanks, chrBanks);
                break;
            case 1:
                this.mapper = new Mapper1(prgBanks, chrBanks);
                break;
            default:
                console.error(`Mapper ${this.mapperId} not supported`);
                return;
        }

        this.valid = true;
        console.log(`ROM loaded: PRG=${prgBanks}x16KB, CHR=${chrBanks}x8KB, Mapper=${this.mapperId}`);
    }

    cpuRead(addr) {
        const mapped = this.mapper?.cpuMapRead(addr);
        if (mapped !== undefined) {
            if (mapped.ram) {
                return this.prgRam[mapped.addr & 0x1FFF];
            }
            return this.prgRom[mapped.addr % this.prgRom.length];
        }
        return undefined;
    }

    cpuWrite(addr, data) {
        const mapped = this.mapper?.cpuMapWrite(addr, data);
        if (mapped !== undefined) {
            if (mapped.ram) {
                this.prgRam[mapped.addr & 0x1FFF] = data;
            }
            return true;
        }
        return false;
    }

    ppuRead(addr) {
        const mapped = this.mapper?.ppuMapRead(addr);
        if (mapped !== undefined) {
            return this.chrRom[mapped % this.chrRom.length];
        }
        return undefined;
    }

    ppuWrite(addr, data) {
        const mapped = this.mapper?.ppuMapWrite(addr);
        if (mapped !== undefined) {
            this.chrRom[mapped % this.chrRom.length] = data;
            return true;
        }
        return false;
    }
}
