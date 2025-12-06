// NES PPU (Picture Processing Unit) Emulator
// Renders 256x240 pixels at 60Hz using pattern tables, nametables, and sprites

export class PPU {
    constructor(bus) {
        this.bus = bus;

        // PPU Memory
        this.patternTable = [new Uint8Array(4096), new Uint8Array(4096)];
        this.nameTable = [new Uint8Array(1024), new Uint8Array(1024)];
        this.palette = new Uint8Array(32);

        // OAM (Object Attribute Memory) for sprites
        this.oam = new Uint8Array(256);
        this.secondaryOam = new Uint8Array(32);

        // Screen output buffer
        this.frameBuffer = new Uint8ClampedArray(256 * 240 * 4);
        this.frameComplete = false;

        // PPU Registers
        this.ppuCtrl = 0;    // $2000
        this.ppuMask = 0;    // $2001
        this.ppuStatus = 0;  // $2002
        this.oamAddr = 0;    // $2003

        // Internal registers
        this.vramAddr = 0;   // Current VRAM address (15 bits)
        this.tramAddr = 0;   // Temporary VRAM address (15 bits)
        this.fineX = 0;      // Fine X scroll (3 bits)
        this.addressLatch = 0;
        this.ppuDataBuffer = 0;

        // Background rendering shift registers
        this.bgShiftPatternLo = 0;
        this.bgShiftPatternHi = 0;
        this.bgShiftAttribLo = 0;
        this.bgShiftAttribHi = 0;

        // Background tile data
        this.bgNextTileId = 0;
        this.bgNextTileAttrib = 0;
        this.bgNextTileLsb = 0;
        this.bgNextTileMsb = 0;

        // Sprite rendering
        this.spriteCount = 0;
        this.spritePatternLo = new Uint8Array(8);
        this.spritePatternHi = new Uint8Array(8);
        this.spriteZeroHitPossible = false;
        this.spriteZeroBeingRendered = false;

        // Timing
        this.scanline = 0;
        this.cycle = 0;
        this.oddFrame = false;

        // NMI
        this.nmiOccurred = false;
        this.nmiOutput = false;

        // PPU Open Bus latch - decays over time in real hardware, we simplify
        this.openBusLatch = 0;

        this.initPalette();
    }

    // NES color palette (RGB values)
    initPalette() {
        this.nesColors = [
            0x626262, 0x001FB2, 0x2404C8, 0x5200B2, 0x730076, 0x800024, 0x730B00, 0x522800,
            0x244400, 0x005700, 0x005C00, 0x005324, 0x003C76, 0x000000, 0x000000, 0x000000,
            0xABABAB, 0x0D57FF, 0x4B30FF, 0x8A13FF, 0xBC08D6, 0xD21269, 0xC72E00, 0x9D5400,
            0x607B00, 0x209800, 0x00A300, 0x009942, 0x007DB4, 0x000000, 0x000000, 0x000000,
            0xFFFFFF, 0x53AEFF, 0x9085FF, 0xD365FF, 0xFF57FF, 0xFF5DCF, 0xFF7757, 0xFA9E00,
            0xBDC700, 0x7AE700, 0x43F611, 0x26EF7E, 0x2CD5F6, 0x4E4E4E, 0x000000, 0x000000,
            0xFFFFFF, 0xB6E1FF, 0xCED1FF, 0xE9C3FF, 0xFFBCFF, 0xFFBDF4, 0xFFC6C3, 0xFFD59A,
            0xE9E681, 0xCEF481, 0xB6FB9A, 0xA9FAC3, 0xA9F0F4, 0xB8B8B8, 0x000000, 0x000000
        ];
    }

    // CPU Read from PPU registers ($2000-$2007)
    // Reading from write-only registers returns PPU open bus (last value on PPU data bus)
    cpuRead(addr) {
        let data = this.openBusLatch; // Default to open bus

        switch (addr) {
            case 0: // PPUCTRL - write only, return open bus
            case 1: // PPUMASK - write only, return open bus
            case 3: // OAMADDR - write only, return open bus
            case 5: // PPUSCROLL - write only, return open bus
            case 6: // PPUADDR - write only, return open bus
                // Return open bus latch (already set as default)
                break;
            case 2: // PPUSTATUS
                // Upper 3 bits are status, lower 5 bits are open bus
                data = (this.ppuStatus & 0xE0) | (this.openBusLatch & 0x1F);
                this.ppuStatus &= ~0x80; // Clear VBlank flag
                this.addressLatch = 0;
                this.nmiOccurred = false;
                // Update open bus with the value that was read
                this.openBusLatch = data;
                break;
            case 4: // OAMDATA
                data = this.oam[this.oamAddr];
                this.openBusLatch = data;
                break;
            case 7: // PPUDATA
                data = this.ppuDataBuffer;
                this.ppuDataBuffer = this.ppuRead(this.vramAddr);
                if (this.vramAddr >= 0x3F00) {
                    // Palette reads are not buffered, return immediately
                    // But lower 6 bits are palette, upper 2 bits are open bus
                    data = (this.ppuDataBuffer & 0x3F) | (this.openBusLatch & 0xC0);
                }
                this.vramAddr += (this.ppuCtrl & 0x04) ? 32 : 1;
                this.vramAddr &= 0x3FFF;
                this.openBusLatch = data;
                break;
        }
        return data;
    }

    // CPU Write to PPU registers
    // All writes fill the open bus latch
    cpuWrite(addr, data) {
        // Every write to PPU sets the open bus latch
        this.openBusLatch = data;

        switch (addr) {
            case 0: // PPUCTRL
                this.ppuCtrl = data;
                this.nmiOutput = (data & 0x80) !== 0;
                this.tramAddr = (this.tramAddr & 0xF3FF) | ((data & 0x03) << 10);
                break;
            case 1: // PPUMASK
                this.ppuMask = data;
                break;
            case 3: // OAMADDR
                this.oamAddr = data;
                break;
            case 4: // OAMDATA
                this.oam[this.oamAddr] = data;
                this.oamAddr = (this.oamAddr + 1) & 0xFF;
                break;
            case 5: // PPUSCROLL
                if (this.addressLatch === 0) {
                    this.fineX = data & 0x07;
                    this.tramAddr = (this.tramAddr & 0xFFE0) | (data >> 3);
                    this.addressLatch = 1;
                } else {
                    this.tramAddr = (this.tramAddr & 0x8C1F) | ((data & 0x07) << 12) | ((data & 0xF8) << 2);
                    this.addressLatch = 0;
                }
                break;
            case 6: // PPUADDR
                if (this.addressLatch === 0) {
                    this.tramAddr = (this.tramAddr & 0x00FF) | ((data & 0x3F) << 8);
                    this.addressLatch = 1;
                } else {
                    this.tramAddr = (this.tramAddr & 0xFF00) | data;
                    this.vramAddr = this.tramAddr;
                    this.addressLatch = 0;
                }
                break;
            case 7: // PPUDATA
                this.ppuWrite(this.vramAddr, data);
                this.vramAddr += (this.ppuCtrl & 0x04) ? 32 : 1;
                this.vramAddr &= 0x3FFF;
                break;
        }
    }

    // PPU internal memory read
    ppuRead(addr) {
        addr &= 0x3FFF;
        const cartData = this.bus.cartridge?.ppuRead(addr);
        if (cartData !== undefined) return cartData;

        if (addr < 0x2000) {
            return this.patternTable[(addr & 0x1000) >> 12][addr & 0x0FFF];
        } else if (addr < 0x3F00) {
            addr &= 0x0FFF;
            if (this.bus.cartridge?.mirror === 1) { // Vertical
                if (addr < 0x0400) return this.nameTable[0][addr & 0x03FF];
                if (addr < 0x0800) return this.nameTable[1][addr & 0x03FF];
                if (addr < 0x0C00) return this.nameTable[0][addr & 0x03FF];
                return this.nameTable[1][addr & 0x03FF];
            } else { // Horizontal
                if (addr < 0x0800) return this.nameTable[0][addr & 0x03FF];
                return this.nameTable[1][addr & 0x03FF];
            }
        } else {
            addr &= 0x1F;
            if (addr === 0x10 || addr === 0x14 || addr === 0x18 || addr === 0x1C) addr &= 0x0F;
            return this.palette[addr];
        }
    }

    // PPU internal memory write
    ppuWrite(addr, data) {
        addr &= 0x3FFF;
        if (this.bus.cartridge?.ppuWrite(addr, data)) return;

        if (addr < 0x2000) {
            this.patternTable[(addr & 0x1000) >> 12][addr & 0x0FFF] = data;
        } else if (addr < 0x3F00) {
            addr &= 0x0FFF;
            if (this.bus.cartridge?.mirror === 1) { // Vertical
                if (addr < 0x0400) this.nameTable[0][addr & 0x03FF] = data;
                else if (addr < 0x0800) this.nameTable[1][addr & 0x03FF] = data;
                else if (addr < 0x0C00) this.nameTable[0][addr & 0x03FF] = data;
                else this.nameTable[1][addr & 0x03FF] = data;
            } else { // Horizontal
                if (addr < 0x0800) this.nameTable[0][addr & 0x03FF] = data;
                else this.nameTable[1][addr & 0x03FF] = data;
            }
        } else {
            addr &= 0x1F;
            if (addr === 0x10 || addr === 0x14 || addr === 0x18 || addr === 0x1C) addr &= 0x0F;
            this.palette[addr] = data;
        }
    }

    // Main clock function - called 3 times per CPU cycle
    clock() {
        if (this.scanline >= -1 && this.scanline < 240) {
            // Background rendering
            if (this.scanline === -1 && this.cycle === 1) {
                this.ppuStatus &= ~0xE0; // Clear VBlank, sprite 0 hit, sprite overflow
                this.spriteZeroHitPossible = false;
                for (let i = 0; i < 8; i++) {
                    this.spritePatternLo[i] = 0;
                    this.spritePatternHi[i] = 0;
                }
            }

            if ((this.cycle >= 2 && this.cycle < 258) || (this.cycle >= 321 && this.cycle < 338)) {
                this.updateShifters();

                switch ((this.cycle - 1) % 8) {
                    case 0:
                        this.loadBackgroundShifters();
                        this.bgNextTileId = this.ppuRead(0x2000 | (this.vramAddr & 0x0FFF));
                        break;
                    case 2:
                        this.bgNextTileAttrib = this.ppuRead(0x23C0 | (this.vramAddr & 0x0C00)
                            | ((this.vramAddr >> 4) & 0x38) | ((this.vramAddr >> 2) & 0x07));
                        if ((this.vramAddr >> 5) & 0x02) this.bgNextTileAttrib >>= 4;
                        if (this.vramAddr & 0x02) this.bgNextTileAttrib >>= 2;
                        this.bgNextTileAttrib &= 0x03;
                        break;
                    case 4:
                        this.bgNextTileLsb = this.ppuRead(((this.ppuCtrl & 0x10) << 8)
                            + (this.bgNextTileId << 4) + ((this.vramAddr >> 12) & 0x07));
                        break;
                    case 6:
                        this.bgNextTileMsb = this.ppuRead(((this.ppuCtrl & 0x10) << 8)
                            + (this.bgNextTileId << 4) + ((this.vramAddr >> 12) & 0x07) + 8);
                        break;
                    case 7:
                        this.incrementScrollX();
                        break;
                }
            }

            if (this.cycle === 256) this.incrementScrollY();
            if (this.cycle === 257) {
                this.loadBackgroundShifters();
                this.transferAddressX();
            }
            if (this.scanline === -1 && this.cycle >= 280 && this.cycle < 305) {
                this.transferAddressY();
            }
            if (this.cycle === 338 || this.cycle === 340) {
                this.bgNextTileId = this.ppuRead(0x2000 | (this.vramAddr & 0x0FFF));
            }

            // Sprite evaluation
            if (this.cycle === 257 && this.scanline >= 0) {
                this.evaluateSprites();
            }
            if (this.cycle === 340) {
                this.loadSpriteShifters();
            }
        }

        // VBlank
        if (this.scanline === 241 && this.cycle === 1) {
            this.ppuStatus |= 0x80;
            this.nmiOccurred = true;
            if (this.nmiOutput) {
                this.bus.cpu?.nmi();
            }
        }

        // Render pixel
        if (this.cycle > 0 && this.cycle <= 256 && this.scanline >= 0 && this.scanline < 240) {
            this.renderPixel();
        }

        // Advance position
        this.cycle++;
        if (this.cycle >= 341) {
            this.cycle = 0;
            this.scanline++;
            if (this.scanline >= 261) {
                this.scanline = -1;
                this.frameComplete = true;
                this.oddFrame = !this.oddFrame;
            }
        }
    }

    renderPixel() {
        let bgPixel = 0, bgPalette = 0;
        let fgPixel = 0, fgPalette = 0, fgPriority = 0;

        // Background pixel
        if (this.ppuMask & 0x08) {
            if ((this.ppuMask & 0x02) || this.cycle > 8) {
                const bitMux = 0x8000 >> this.fineX;
                const p0 = (this.bgShiftPatternLo & bitMux) > 0 ? 1 : 0;
                const p1 = (this.bgShiftPatternHi & bitMux) > 0 ? 1 : 0;
                bgPixel = (p1 << 1) | p0;
                const a0 = (this.bgShiftAttribLo & bitMux) > 0 ? 1 : 0;
                const a1 = (this.bgShiftAttribHi & bitMux) > 0 ? 1 : 0;
                bgPalette = (a1 << 1) | a0;
            }
        }

        // Foreground sprite pixel
        if (this.ppuMask & 0x10) {
            if ((this.ppuMask & 0x04) || this.cycle > 8) {
                this.spriteZeroBeingRendered = false;
                for (let i = 0; i < this.spriteCount; i++) {
                    const x = this.secondaryOam[i * 4 + 3];
                    if (x === 0) {
                        const p0 = (this.spritePatternLo[i] & 0x80) > 0 ? 1 : 0;
                        const p1 = (this.spritePatternHi[i] & 0x80) > 0 ? 1 : 0;
                        fgPixel = (p1 << 1) | p0;
                        fgPalette = (this.secondaryOam[i * 4 + 2] & 0x03) + 4;
                        fgPriority = (this.secondaryOam[i * 4 + 2] & 0x20) === 0 ? 1 : 0;
                        if (fgPixel !== 0) {
                            if (i === 0) this.spriteZeroBeingRendered = true;
                            break;
                        }
                    }
                }
            }
        }

        // Combine and output
        let pixel = 0, palette = 0;
        if (bgPixel === 0 && fgPixel === 0) {
            pixel = 0; palette = 0;
        } else if (bgPixel === 0 && fgPixel > 0) {
            pixel = fgPixel; palette = fgPalette;
        } else if (bgPixel > 0 && fgPixel === 0) {
            pixel = bgPixel; palette = bgPalette;
        } else {
            if (fgPriority) { pixel = fgPixel; palette = fgPalette; }
            else { pixel = bgPixel; palette = bgPalette; }

            // Sprite 0 hit
            if (this.spriteZeroHitPossible && this.spriteZeroBeingRendered) {
                if ((this.ppuMask & 0x18) === 0x18) {
                    if (!((this.ppuMask & 0x06) && this.cycle < 9)) {
                        if (this.cycle !== 255) {
                            this.ppuStatus |= 0x40;
                        }
                    }
                }
            }
        }

        const color = this.getColorFromPalette(palette, pixel);
        this.setPixel(this.cycle - 1, this.scanline, color);
    }

    getColorFromPalette(palette, pixel) {
        return this.nesColors[this.ppuRead(0x3F00 + (palette << 2) + pixel) & 0x3F];
    }

    setPixel(x, y, color) {
        if (x < 0 || x >= 256 || y < 0 || y >= 240) return;
        const idx = (y * 256 + x) * 4;
        this.frameBuffer[idx] = (color >> 16) & 0xFF;
        this.frameBuffer[idx + 1] = (color >> 8) & 0xFF;
        this.frameBuffer[idx + 2] = color & 0xFF;
        this.frameBuffer[idx + 3] = 255;
    }

    // Scrolling helpers
    incrementScrollX() {
        if ((this.ppuMask & 0x18) !== 0) {
            if ((this.vramAddr & 0x001F) === 31) {
                this.vramAddr &= ~0x001F;
                this.vramAddr ^= 0x0400;
            } else {
                this.vramAddr++;
            }
        }
    }

    incrementScrollY() {
        if ((this.ppuMask & 0x18) !== 0) {
            if ((this.vramAddr & 0x7000) !== 0x7000) {
                this.vramAddr += 0x1000;
            } else {
                this.vramAddr &= ~0x7000;
                let y = (this.vramAddr & 0x03E0) >> 5;
                if (y === 29) { y = 0; this.vramAddr ^= 0x0800; }
                else if (y === 31) { y = 0; }
                else { y++; }
                this.vramAddr = (this.vramAddr & ~0x03E0) | (y << 5);
            }
        }
    }

    transferAddressX() {
        if ((this.ppuMask & 0x18) !== 0) {
            this.vramAddr = (this.vramAddr & ~0x041F) | (this.tramAddr & 0x041F);
        }
    }

    transferAddressY() {
        if ((this.ppuMask & 0x18) !== 0) {
            this.vramAddr = (this.vramAddr & ~0x7BE0) | (this.tramAddr & 0x7BE0);
        }
    }

    loadBackgroundShifters() {
        this.bgShiftPatternLo = (this.bgShiftPatternLo & 0xFF00) | this.bgNextTileLsb;
        this.bgShiftPatternHi = (this.bgShiftPatternHi & 0xFF00) | this.bgNextTileMsb;
        this.bgShiftAttribLo = (this.bgShiftAttribLo & 0xFF00) | ((this.bgNextTileAttrib & 0x01) ? 0xFF : 0x00);
        this.bgShiftAttribHi = (this.bgShiftAttribHi & 0xFF00) | ((this.bgNextTileAttrib & 0x02) ? 0xFF : 0x00);
    }

    updateShifters() {
        if (this.ppuMask & 0x08) {
            this.bgShiftPatternLo <<= 1;
            this.bgShiftPatternHi <<= 1;
            this.bgShiftAttribLo <<= 1;
            this.bgShiftAttribHi <<= 1;
        }
        if ((this.ppuMask & 0x10) && this.cycle >= 1 && this.cycle < 258) {
            for (let i = 0; i < this.spriteCount; i++) {
                if (this.secondaryOam[i * 4 + 3] > 0) {
                    this.secondaryOam[i * 4 + 3]--;
                } else {
                    this.spritePatternLo[i] <<= 1;
                    this.spritePatternHi[i] <<= 1;
                }
            }
        }
    }

    evaluateSprites() {
        for (let i = 0; i < 32; i++) this.secondaryOam[i] = 0xFF;
        this.spriteCount = 0;

        const spriteSize = (this.ppuCtrl & 0x20) ? 16 : 8;
        for (let i = 0; i < 64 && this.spriteCount < 8; i++) {
            const diff = this.scanline - this.oam[i * 4];
            if (diff >= 0 && diff < spriteSize) {
                if (this.spriteCount < 8) {
                    if (i === 0) this.spriteZeroHitPossible = true;
                    for (let j = 0; j < 4; j++) {
                        this.secondaryOam[this.spriteCount * 4 + j] = this.oam[i * 4 + j];
                    }
                    this.spriteCount++;
                }
            }
        }
    }

    loadSpriteShifters() {
        const spriteSize = (this.ppuCtrl & 0x20) ? 16 : 8;
        for (let i = 0; i < this.spriteCount; i++) {
            let spritePatternAddrLo, spritePatternAddrHi;
            const y = this.secondaryOam[i * 4];
            const tile = this.secondaryOam[i * 4 + 1];
            const attr = this.secondaryOam[i * 4 + 2];

            if (spriteSize === 8) {
                const table = (this.ppuCtrl & 0x08) ? 0x1000 : 0x0000;
                if (!(attr & 0x80)) { // Not flipped vertically
                    spritePatternAddrLo = table + (tile << 4) + (this.scanline - y);
                } else {
                    spritePatternAddrLo = table + (tile << 4) + (7 - (this.scanline - y));
                }
            } else {
                const table = (tile & 0x01) ? 0x1000 : 0x0000;
                const tileIndex = tile & 0xFE;
                const row = this.scanline - y;
                if (!(attr & 0x80)) {
                    if (row < 8) {
                        spritePatternAddrLo = table + (tileIndex << 4) + row;
                    } else {
                        spritePatternAddrLo = table + ((tileIndex + 1) << 4) + (row - 8);
                    }
                } else {
                    if (row < 8) {
                        spritePatternAddrLo = table + ((tileIndex + 1) << 4) + (7 - row);
                    } else {
                        spritePatternAddrLo = table + (tileIndex << 4) + (15 - row);
                    }
                }
            }

            spritePatternAddrHi = spritePatternAddrLo + 8;
            let spriteLo = this.ppuRead(spritePatternAddrLo);
            let spriteHi = this.ppuRead(spritePatternAddrHi);

            // Horizontal flip
            if (attr & 0x40) {
                spriteLo = this.flipByte(spriteLo);
                spriteHi = this.flipByte(spriteHi);
            }

            this.spritePatternLo[i] = spriteLo;
            this.spritePatternHi[i] = spriteHi;
        }
    }

    flipByte(b) {
        b = ((b & 0xF0) >> 4) | ((b & 0x0F) << 4);
        b = ((b & 0xCC) >> 2) | ((b & 0x33) << 2);
        b = ((b & 0xAA) >> 1) | ((b & 0x55) << 1);
        return b;
    }

    getState() {
        return `SL:${this.scanline} CY:${this.cycle}`;
    }
}
