// NES 6502 CPU Emulator
// The 6502 is an 8-bit processor with 16-bit addressing

export class CPU {
    constructor(bus) {
        this.bus = bus;
        this.reset();
        this.buildInstructionTable();
    }

    reset() {
        // Registers
        this.a = 0x00;      // Accumulator
        this.x = 0x00;      // X Index
        this.y = 0x00;      // Y Index
        this.sp = 0xFD;     // Stack Pointer
        this.pc = 0x0000;   // Program Counter

        // Status flags (NV-BDIZC)
        this.status = {
            c: false,  // Carry
            z: false,  // Zero
            i: true,   // Interrupt Disable
            d: false,  // Decimal (unused on NES)
            b: false,  // Break
            u: true,   // Unused (always 1)
            v: false,  // Overflow
            n: false   // Negative
        };

        // Internal
        this.cycles = 0;
        this.totalCycles = 0;
        this.opcode = 0;
        this.fetched = 0;
        this.addrAbs = 0;
        this.addrRel = 0;

        // Track if current instruction is a write instruction (for dummy cycles)
        this.isWriteInstruction = false;
        // Track the unfixed address for dummy reads (page crossing)
        this.addrAbsUnfixed = 0;
        // Track if page was crossed (for dummy read)
        this.pageCrossed = false;

        // Read reset vector
        const lo = this.read(0xFFFC);
        const hi = this.read(0xFFFD);
        this.pc = (hi << 8) | lo;
    }

    // Memory access
    read(addr) {
        return this.bus.cpuRead(addr & 0xFFFF);
    }

    write(addr, data) {
        this.bus.cpuWrite(addr & 0xFFFF, data & 0xFF);
    }

    // Get/Set status register as byte
    getStatus() {
        let s = 0;
        s |= this.status.c ? 0x01 : 0;
        s |= this.status.z ? 0x02 : 0;
        s |= this.status.i ? 0x04 : 0;
        s |= this.status.d ? 0x08 : 0;
        s |= this.status.b ? 0x10 : 0;
        s |= this.status.u ? 0x20 : 0;
        s |= this.status.v ? 0x40 : 0;
        s |= this.status.n ? 0x80 : 0;
        return s;
    }

    setStatus(s) {
        this.status.c = (s & 0x01) !== 0;
        this.status.z = (s & 0x02) !== 0;
        this.status.i = (s & 0x04) !== 0;
        this.status.d = (s & 0x08) !== 0;
        this.status.b = (s & 0x10) !== 0;
        this.status.u = (s & 0x20) !== 0;
        this.status.v = (s & 0x40) !== 0;
        this.status.n = (s & 0x80) !== 0;
    }

    // Stack operations
    push(data) {
        this.write(0x0100 + this.sp, data);
        this.sp = (this.sp - 1) & 0xFF;
    }

    pop() {
        this.sp = (this.sp + 1) & 0xFF;
        return this.read(0x0100 + this.sp);
    }

    // Interrupts
    nmi() {
        this.push((this.pc >> 8) & 0xFF);
        this.push(this.pc & 0xFF);
        this.status.b = false;
        this.status.u = true;
        this.status.i = true;
        this.push(this.getStatus());
        this.addrAbs = 0xFFFA;
        const lo = this.read(0xFFFA);
        const hi = this.read(0xFFFB);
        this.pc = (hi << 8) | lo;
        this.cycles = 8;
    }

    irq() {
        if (!this.status.i) {
            this.push((this.pc >> 8) & 0xFF);
            this.push(this.pc & 0xFF);
            this.status.b = false;
            this.status.u = true;
            this.status.i = true;
            this.push(this.getStatus());
            this.addrAbs = 0xFFFE;
            const lo = this.read(0xFFFE);
            const hi = this.read(0xFFFF);
            this.pc = (hi << 8) | lo;
            this.cycles = 7;
        }
    }

    // Execute one instruction
    clock() {
        if (this.cycles === 0) {
            this.opcode = this.read(this.pc);
            this.pc = (this.pc + 1) & 0xFFFF;
            this.status.u = true;

            const instr = this.instructions[this.opcode];
            this.cycles = instr.cycles;

            const addrCycle = instr.addrMode.call(this);
            const opCycle = instr.operate.call(this);

            this.cycles += (addrCycle & opCycle);
            this.status.u = true;
        }
        this.cycles--;
        this.totalCycles++;
    }

    // Run until specified cycles consumed
    step() {
        do { this.clock(); } while (this.cycles > 0);
    }

    // ===== ADDRESSING MODES =====
    IMP() { this.fetched = this.a; return 0; }

    IMM() { this.addrAbs = this.pc++; this.pc &= 0xFFFF; return 0; }

    ZP0() { this.addrAbs = this.read(this.pc++) & 0xFF; this.pc &= 0xFFFF; return 0; }

    ZPX() { this.addrAbs = (this.read(this.pc++) + this.x) & 0xFF; this.pc &= 0xFFFF; return 0; }

    ZPY() { this.addrAbs = (this.read(this.pc++) + this.y) & 0xFF; this.pc &= 0xFFFF; return 0; }

    REL() {
        this.addrRel = this.read(this.pc++);
        this.pc &= 0xFFFF;
        if (this.addrRel & 0x80) this.addrRel |= 0xFF00;
        return 0;
    }

    ABS() {
        const lo = this.read(this.pc++); this.pc &= 0xFFFF;
        const hi = this.read(this.pc++); this.pc &= 0xFFFF;
        this.addrAbs = (hi << 8) | lo;
        return 0;
    }

    ABX() {
        const lo = this.read(this.pc++); this.pc &= 0xFFFF;
        const hi = this.read(this.pc++); this.pc &= 0xFFFF;
        const base = (hi << 8) | lo;
        this.addrAbs = (base + this.x) & 0xFFFF;
        // Store unfixed address for dummy read
        this.addrAbsUnfixed = (hi << 8) | ((lo + this.x) & 0xFF);
        this.pageCrossed = (this.addrAbs & 0xFF00) !== (base & 0xFF00);
        // For read instructions, page crossing adds a cycle
        // For write instructions, always add a cycle (handled in instruction)
        return this.pageCrossed ? 1 : 0;
    }

    ABY() {
        const lo = this.read(this.pc++); this.pc &= 0xFFFF;
        const hi = this.read(this.pc++); this.pc &= 0xFFFF;
        const base = (hi << 8) | lo;
        this.addrAbs = (base + this.y) & 0xFFFF;
        // Store unfixed address for dummy read
        this.addrAbsUnfixed = (hi << 8) | ((lo + this.y) & 0xFF);
        this.pageCrossed = (this.addrAbs & 0xFF00) !== (base & 0xFF00);
        return this.pageCrossed ? 1 : 0;
    }

    IND() {
        const ptrLo = this.read(this.pc++); this.pc &= 0xFFFF;
        const ptrHi = this.read(this.pc++); this.pc &= 0xFFFF;
        const ptr = (ptrHi << 8) | ptrLo;
        // Hardware bug: if low byte is 0xFF, high byte wraps within page
        if (ptrLo === 0xFF) {
            this.addrAbs = (this.read(ptr & 0xFF00) << 8) | this.read(ptr);
        } else {
            this.addrAbs = (this.read(ptr + 1) << 8) | this.read(ptr);
        }
        return 0;
    }

    IZX() {
        const t = this.read(this.pc++); this.pc &= 0xFFFF;
        const lo = this.read((t + this.x) & 0xFF);
        const hi = this.read((t + this.x + 1) & 0xFF);
        this.addrAbs = (hi << 8) | lo;
        return 0;
    }

    IZY() {
        const t = this.read(this.pc++); this.pc &= 0xFFFF;
        const lo = this.read(t & 0xFF);
        const hi = this.read((t + 1) & 0xFF);
        const base = (hi << 8) | lo;
        this.addrAbs = (base + this.y) & 0xFFFF;
        // Store unfixed address for dummy read
        this.addrAbsUnfixed = (hi << 8) | ((lo + this.y) & 0xFF);
        this.pageCrossed = (this.addrAbs & 0xFF00) !== (base & 0xFF00);
        return this.pageCrossed ? 1 : 0;
    }

    // Fetch data from address
    // For indexed modes with page crossing, perform dummy read at unfixed address first
    // Requirement 1: LDA abs,X crossing page should read PPU_STATUS twice
    // Requirements 2-3: No dummy read if no page crossing
    // Requirements 6-7: LDA (ind),Y same behavior
    fetch() {
        if (this.instructions[this.opcode].addrMode !== this.IMP) {
            const addrMode = this.instructions[this.opcode].addrMode;

            // For indexed modes with page crossing, do dummy read at unfixed address
            // Requirement A: LDA (ind,X) should NOT have dummy read
            if (this.pageCrossed && (addrMode === this.ABX || addrMode === this.ABY || addrMode === this.IZY)) {
                this.read(this.addrAbsUnfixed); // Dummy read at wrong address
            }

            this.fetched = this.read(this.addrAbs);
        }
        return this.fetched;
    }

    // ===== OPCODES =====
    ADC() {
        this.fetch();
        const temp = this.a + this.fetched + (this.status.c ? 1 : 0);
        this.status.c = temp > 255;
        this.status.z = (temp & 0xFF) === 0;
        this.status.v = (~(this.a ^ this.fetched) & (this.a ^ temp) & 0x80) !== 0;
        this.status.n = (temp & 0x80) !== 0;
        this.a = temp & 0xFF;
        return 1;
    }

    AND() {
        this.fetch();
        this.a &= this.fetched;
        this.status.z = this.a === 0;
        this.status.n = (this.a & 0x80) !== 0;
        return 1;
    }

    ASL() {
        this.fetch();
        const temp = this.fetched << 1;
        this.status.c = (temp & 0xFF00) > 0;
        this.status.z = (temp & 0xFF) === 0;
        this.status.n = (temp & 0x80) !== 0;
        if (this.instructions[this.opcode].addrMode === this.IMP) {
            this.a = temp & 0xFF;
        } else {
            // RMW: Dummy write of original value, then write modified value
            this.write(this.addrAbs, this.fetched); // Dummy write
            this.write(this.addrAbs, temp & 0xFF);  // Actual write
        }
        return 0;
    }

    BCC() { if (!this.status.c) { return this.branch(); } return 0; }
    BCS() { if (this.status.c) { return this.branch(); } return 0; }
    BEQ() { if (this.status.z) { return this.branch(); } return 0; }

    BIT() {
        this.fetch();
        const temp = this.a & this.fetched;
        this.status.z = (temp & 0xFF) === 0;
        this.status.n = (this.fetched & 0x80) !== 0;
        this.status.v = (this.fetched & 0x40) !== 0;
        return 0;
    }

    BMI() { if (this.status.n) { return this.branch(); } return 0; }
    BNE() { if (!this.status.z) { return this.branch(); } return 0; }
    BPL() { if (!this.status.n) { return this.branch(); } return 0; }

    BRK() {
        this.pc++;
        this.status.i = true;
        this.push((this.pc >> 8) & 0xFF);
        this.push(this.pc & 0xFF);
        this.status.b = true;
        this.push(this.getStatus());
        this.status.b = false;
        this.pc = this.read(0xFFFE) | (this.read(0xFFFF) << 8);
        return 0;
    }

    BVC() { if (!this.status.v) { return this.branch(); } return 0; }
    BVS() { if (this.status.v) { return this.branch(); } return 0; }

    CLC() { this.status.c = false; return 0; }
    CLD() { this.status.d = false; return 0; }
    CLI() { this.status.i = false; return 0; }
    CLV() { this.status.v = false; return 0; }

    CMP() { this.fetch(); return this.compare(this.a, this.fetched); }
    CPX() { this.fetch(); return this.compare(this.x, this.fetched); }
    CPY() { this.fetch(); return this.compare(this.y, this.fetched); }

    DEC() {
        this.fetch();
        const temp = (this.fetched - 1) & 0xFF;
        // RMW: Dummy write of original value, then write modified value
        this.write(this.addrAbs, this.fetched); // Dummy write
        this.write(this.addrAbs, temp);          // Actual write
        this.status.z = temp === 0;
        this.status.n = (temp & 0x80) !== 0;
        return 0;
    }

    DEX() { this.x = (this.x - 1) & 0xFF; this.setZN(this.x); return 0; }
    DEY() { this.y = (this.y - 1) & 0xFF; this.setZN(this.y); return 0; }

    EOR() {
        this.fetch();
        this.a ^= this.fetched;
        this.setZN(this.a);
        return 1;
    }

    INC() {
        this.fetch();
        const temp = (this.fetched + 1) & 0xFF;
        // RMW: Dummy write of original value, then write modified value
        this.write(this.addrAbs, this.fetched); // Dummy write
        this.write(this.addrAbs, temp);          // Actual write
        this.setZN(temp);
        return 0;
    }

    INX() { this.x = (this.x + 1) & 0xFF; this.setZN(this.x); return 0; }
    INY() { this.y = (this.y + 1) & 0xFF; this.setZN(this.y); return 0; }

    JMP() { this.pc = this.addrAbs; return 0; }

    JSR() {
        this.pc--;
        this.push((this.pc >> 8) & 0xFF);
        this.push(this.pc & 0xFF);
        this.pc = this.addrAbs;
        return 0;
    }

    LDA() { this.fetch(); this.a = this.fetched; this.setZN(this.a); return 1; }
    LDX() { this.fetch(); this.x = this.fetched; this.setZN(this.x); return 1; }
    LDY() { this.fetch(); this.y = this.fetched; this.setZN(this.y); return 1; }

    LSR() {
        this.fetch();
        this.status.c = (this.fetched & 0x01) !== 0;
        const temp = this.fetched >> 1;
        this.status.z = temp === 0;
        this.status.n = false;
        if (this.instructions[this.opcode].addrMode === this.IMP) {
            this.a = temp;
        } else {
            // RMW: Dummy write of original value, then write modified value
            this.write(this.addrAbs, this.fetched); // Dummy write
            this.write(this.addrAbs, temp);          // Actual write
        }
        return 0;
    }

    NOP() {
        // Some unofficial NOPs have different cycle counts
        switch (this.opcode) {
            case 0x1C: case 0x3C: case 0x5C: case 0x7C: case 0xDC: case 0xFC:
                return 1;
        }
        return 0;
    }

    ORA() { this.fetch(); this.a |= this.fetched; this.setZN(this.a); return 1; }

    PHA() { this.push(this.a); return 0; }
    PHP() { this.push(this.getStatus() | 0x10 | 0x20); return 0; }
    PLA() { this.a = this.pop(); this.setZN(this.a); return 0; }
    PLP() { this.setStatus(this.pop()); this.status.u = true; return 0; }

    ROL() {
        this.fetch();
        const temp = (this.fetched << 1) | (this.status.c ? 1 : 0);
        this.status.c = (temp & 0xFF00) !== 0;
        this.status.z = (temp & 0xFF) === 0;
        this.status.n = (temp & 0x80) !== 0;
        if (this.instructions[this.opcode].addrMode === this.IMP) {
            this.a = temp & 0xFF;
        } else {
            // RMW: Dummy write of original value, then write modified value
            this.write(this.addrAbs, this.fetched); // Dummy write
            this.write(this.addrAbs, temp & 0xFF);  // Actual write
        }
        return 0;
    }

    ROR() {
        this.fetch();
        const temp = ((this.status.c ? 1 : 0) << 7) | (this.fetched >> 1);
        this.status.c = (this.fetched & 0x01) !== 0;
        this.status.z = temp === 0;
        this.status.n = (temp & 0x80) !== 0;
        if (this.instructions[this.opcode].addrMode === this.IMP) {
            this.a = temp;
        } else {
            // RMW: Dummy write of original value, then write modified value
            this.write(this.addrAbs, this.fetched); // Dummy write
            this.write(this.addrAbs, temp);          // Actual write
        }
        return 0;
    }

    RTI() {
        this.setStatus(this.pop());
        this.status.b = false;
        this.status.u = true;
        const lo = this.pop();
        const hi = this.pop();
        this.pc = (hi << 8) | lo;
        return 0;
    }

    RTS() {
        const lo = this.pop();
        const hi = this.pop();
        this.pc = ((hi << 8) | lo) + 1;
        this.pc &= 0xFFFF;
        return 0;
    }

    SBC() {
        this.fetch();
        const value = this.fetched ^ 0xFF;
        const temp = this.a + value + (this.status.c ? 1 : 0);
        this.status.c = (temp & 0xFF00) !== 0;
        this.status.z = (temp & 0xFF) === 0;
        this.status.v = ((temp ^ this.a) & (temp ^ value) & 0x80) !== 0;
        this.status.n = (temp & 0x80) !== 0;
        this.a = temp & 0xFF;
        return 1;
    }

    SEC() { this.status.c = true; return 0; }
    SED() { this.status.d = true; return 0; }
    SEI() { this.status.i = true; return 0; }

    // Store instructions with dummy read support
    // Requirements 4-5: STA ABX/ABY always does dummy read at unfixed address
    // Requirements 8-9: STA IZY only does dummy read if page crossed
    // Requirement A-B: STA IZX never does dummy read
    STA() {
        const addrMode = this.instructions[this.opcode].addrMode;

        // ABX and ABY always do a dummy read at the unfixed address
        if (addrMode === this.ABX || addrMode === this.ABY) {
            this.read(this.addrAbsUnfixed); // Dummy read
        }
        // IZY only does dummy read if page was crossed
        else if (addrMode === this.IZY && this.pageCrossed) {
            this.read(this.addrAbsUnfixed); // Dummy read
        }
        // IZX: no dummy read (req A-B)

        this.write(this.addrAbs, this.a);
        return 0;
    }
    STX() { this.write(this.addrAbs, this.x); return 0; }
    STY() { this.write(this.addrAbs, this.y); return 0; }

    TAX() { this.x = this.a; this.setZN(this.x); return 0; }
    TAY() { this.y = this.a; this.setZN(this.y); return 0; }
    TSX() { this.x = this.sp; this.setZN(this.x); return 0; }
    TXA() { this.a = this.x; this.setZN(this.a); return 0; }
    TXS() { this.sp = this.x; return 0; }
    TYA() { this.a = this.y; this.setZN(this.a); return 0; }

    // Illegal/unofficial opcode - treated as NOP
    XXX() { return 0; }

    // ===== HELPERS =====
    setZN(value) {
        this.status.z = value === 0;
        this.status.n = (value & 0x80) !== 0;
    }

    compare(reg, mem) {
        const temp = reg - mem;
        this.status.c = reg >= mem;
        this.status.z = (temp & 0xFF) === 0;
        this.status.n = (temp & 0x80) !== 0;
        return 1;
    }

    branch() {
        this.cycles++;
        this.addrAbs = (this.pc + this.addrRel) & 0xFFFF;
        if ((this.addrAbs & 0xFF00) !== (this.pc & 0xFF00)) {
            this.cycles++;
        }
        this.pc = this.addrAbs;
        return 0;
    }

    // Build instruction lookup table
    buildInstructionTable() {
        const m = (name, operate, addrMode, cycles) => ({ name, operate, addrMode, cycles });
        const o = this;

        this.instructions = [
            m("BRK", o.BRK, o.IMP, 7), m("ORA", o.ORA, o.IZX, 6), m("???", o.XXX, o.IMP, 2), m("???", o.XXX, o.IMP, 8),
            m("NOP", o.NOP, o.ZP0, 3), m("ORA", o.ORA, o.ZP0, 3), m("ASL", o.ASL, o.ZP0, 5), m("???", o.XXX, o.IMP, 5),
            m("PHP", o.PHP, o.IMP, 3), m("ORA", o.ORA, o.IMM, 2), m("ASL", o.ASL, o.IMP, 2), m("???", o.XXX, o.IMP, 2),
            m("NOP", o.NOP, o.ABS, 4), m("ORA", o.ORA, o.ABS, 4), m("ASL", o.ASL, o.ABS, 6), m("???", o.XXX, o.IMP, 6),
            m("BPL", o.BPL, o.REL, 2), m("ORA", o.ORA, o.IZY, 5), m("???", o.XXX, o.IMP, 2), m("???", o.XXX, o.IMP, 8),
            m("NOP", o.NOP, o.ZPX, 4), m("ORA", o.ORA, o.ZPX, 4), m("ASL", o.ASL, o.ZPX, 6), m("???", o.XXX, o.IMP, 6),
            m("CLC", o.CLC, o.IMP, 2), m("ORA", o.ORA, o.ABY, 4), m("NOP", o.NOP, o.IMP, 2), m("???", o.XXX, o.IMP, 7),
            m("NOP", o.NOP, o.ABX, 4), m("ORA", o.ORA, o.ABX, 4), m("ASL", o.ASL, o.ABX, 7), m("???", o.XXX, o.IMP, 7),
            m("JSR", o.JSR, o.ABS, 6), m("AND", o.AND, o.IZX, 6), m("???", o.XXX, o.IMP, 2), m("???", o.XXX, o.IMP, 8),
            m("BIT", o.BIT, o.ZP0, 3), m("AND", o.AND, o.ZP0, 3), m("ROL", o.ROL, o.ZP0, 5), m("???", o.XXX, o.IMP, 5),
            m("PLP", o.PLP, o.IMP, 4), m("AND", o.AND, o.IMM, 2), m("ROL", o.ROL, o.IMP, 2), m("???", o.XXX, o.IMP, 2),
            m("BIT", o.BIT, o.ABS, 4), m("AND", o.AND, o.ABS, 4), m("ROL", o.ROL, o.ABS, 6), m("???", o.XXX, o.IMP, 6),
            m("BMI", o.BMI, o.REL, 2), m("AND", o.AND, o.IZY, 5), m("???", o.XXX, o.IMP, 2), m("???", o.XXX, o.IMP, 8),
            m("NOP", o.NOP, o.ZPX, 4), m("AND", o.AND, o.ZPX, 4), m("ROL", o.ROL, o.ZPX, 6), m("???", o.XXX, o.IMP, 6),
            m("SEC", o.SEC, o.IMP, 2), m("AND", o.AND, o.ABY, 4), m("NOP", o.NOP, o.IMP, 2), m("???", o.XXX, o.IMP, 7),
            m("NOP", o.NOP, o.ABX, 4), m("AND", o.AND, o.ABX, 4), m("ROL", o.ROL, o.ABX, 7), m("???", o.XXX, o.IMP, 7),
            m("RTI", o.RTI, o.IMP, 6), m("EOR", o.EOR, o.IZX, 6), m("???", o.XXX, o.IMP, 2), m("???", o.XXX, o.IMP, 8),
            m("NOP", o.NOP, o.ZP0, 3), m("EOR", o.EOR, o.ZP0, 3), m("LSR", o.LSR, o.ZP0, 5), m("???", o.XXX, o.IMP, 5),
            m("PHA", o.PHA, o.IMP, 3), m("EOR", o.EOR, o.IMM, 2), m("LSR", o.LSR, o.IMP, 2), m("???", o.XXX, o.IMP, 2),
            m("JMP", o.JMP, o.ABS, 3), m("EOR", o.EOR, o.ABS, 4), m("LSR", o.LSR, o.ABS, 6), m("???", o.XXX, o.IMP, 6),
            m("BVC", o.BVC, o.REL, 2), m("EOR", o.EOR, o.IZY, 5), m("???", o.XXX, o.IMP, 2), m("???", o.XXX, o.IMP, 8),
            m("NOP", o.NOP, o.ZPX, 4), m("EOR", o.EOR, o.ZPX, 4), m("LSR", o.LSR, o.ZPX, 6), m("???", o.XXX, o.IMP, 6),
            m("CLI", o.CLI, o.IMP, 2), m("EOR", o.EOR, o.ABY, 4), m("NOP", o.NOP, o.IMP, 2), m("???", o.XXX, o.IMP, 7),
            m("NOP", o.NOP, o.ABX, 4), m("EOR", o.EOR, o.ABX, 4), m("LSR", o.LSR, o.ABX, 7), m("???", o.XXX, o.IMP, 7),
            m("RTS", o.RTS, o.IMP, 6), m("ADC", o.ADC, o.IZX, 6), m("???", o.XXX, o.IMP, 2), m("???", o.XXX, o.IMP, 8),
            m("NOP", o.NOP, o.ZP0, 3), m("ADC", o.ADC, o.ZP0, 3), m("ROR", o.ROR, o.ZP0, 5), m("???", o.XXX, o.IMP, 5),
            m("PLA", o.PLA, o.IMP, 4), m("ADC", o.ADC, o.IMM, 2), m("ROR", o.ROR, o.IMP, 2), m("???", o.XXX, o.IMP, 2),
            m("JMP", o.JMP, o.IND, 5), m("ADC", o.ADC, o.ABS, 4), m("ROR", o.ROR, o.ABS, 6), m("???", o.XXX, o.IMP, 6),
            m("BVS", o.BVS, o.REL, 2), m("ADC", o.ADC, o.IZY, 5), m("???", o.XXX, o.IMP, 2), m("???", o.XXX, o.IMP, 8),
            m("NOP", o.NOP, o.ZPX, 4), m("ADC", o.ADC, o.ZPX, 4), m("ROR", o.ROR, o.ZPX, 6), m("???", o.XXX, o.IMP, 6),
            m("SEI", o.SEI, o.IMP, 2), m("ADC", o.ADC, o.ABY, 4), m("NOP", o.NOP, o.IMP, 2), m("???", o.XXX, o.IMP, 7),
            m("NOP", o.NOP, o.ABX, 4), m("ADC", o.ADC, o.ABX, 4), m("ROR", o.ROR, o.ABX, 7), m("???", o.XXX, o.IMP, 7),
            m("NOP", o.NOP, o.IMM, 2), m("STA", o.STA, o.IZX, 6), m("NOP", o.NOP, o.IMM, 2), m("???", o.XXX, o.IMP, 6),
            m("STY", o.STY, o.ZP0, 3), m("STA", o.STA, o.ZP0, 3), m("STX", o.STX, o.ZP0, 3), m("???", o.XXX, o.IMP, 3),
            m("DEY", o.DEY, o.IMP, 2), m("NOP", o.NOP, o.IMM, 2), m("TXA", o.TXA, o.IMP, 2), m("???", o.XXX, o.IMP, 2),
            m("STY", o.STY, o.ABS, 4), m("STA", o.STA, o.ABS, 4), m("STX", o.STX, o.ABS, 4), m("???", o.XXX, o.IMP, 4),
            m("BCC", o.BCC, o.REL, 2), m("STA", o.STA, o.IZY, 6), m("???", o.XXX, o.IMP, 2), m("???", o.XXX, o.IMP, 6),
            m("STY", o.STY, o.ZPX, 4), m("STA", o.STA, o.ZPX, 4), m("STX", o.STX, o.ZPY, 4), m("???", o.XXX, o.IMP, 4),
            m("TYA", o.TYA, o.IMP, 2), m("STA", o.STA, o.ABY, 5), m("TXS", o.TXS, o.IMP, 2), m("???", o.XXX, o.IMP, 5),
            m("???", o.XXX, o.IMP, 5), m("STA", o.STA, o.ABX, 5), m("???", o.XXX, o.IMP, 5), m("???", o.XXX, o.IMP, 5),
            m("LDY", o.LDY, o.IMM, 2), m("LDA", o.LDA, o.IZX, 6), m("LDX", o.LDX, o.IMM, 2), m("???", o.XXX, o.IMP, 6),
            m("LDY", o.LDY, o.ZP0, 3), m("LDA", o.LDA, o.ZP0, 3), m("LDX", o.LDX, o.ZP0, 3), m("???", o.XXX, o.IMP, 3),
            m("TAY", o.TAY, o.IMP, 2), m("LDA", o.LDA, o.IMM, 2), m("TAX", o.TAX, o.IMP, 2), m("???", o.XXX, o.IMP, 2),
            m("LDY", o.LDY, o.ABS, 4), m("LDA", o.LDA, o.ABS, 4), m("LDX", o.LDX, o.ABS, 4), m("???", o.XXX, o.IMP, 4),
            m("BCS", o.BCS, o.REL, 2), m("LDA", o.LDA, o.IZY, 5), m("???", o.XXX, o.IMP, 2), m("???", o.XXX, o.IMP, 5),
            m("LDY", o.LDY, o.ZPX, 4), m("LDA", o.LDA, o.ZPX, 4), m("LDX", o.LDX, o.ZPY, 4), m("???", o.XXX, o.IMP, 4),
            m("CLV", o.CLV, o.IMP, 2), m("LDA", o.LDA, o.ABY, 4), m("TSX", o.TSX, o.IMP, 2), m("???", o.XXX, o.IMP, 4),
            m("LDY", o.LDY, o.ABX, 4), m("LDA", o.LDA, o.ABX, 4), m("LDX", o.LDX, o.ABY, 4), m("???", o.XXX, o.IMP, 4),
            m("CPY", o.CPY, o.IMM, 2), m("CMP", o.CMP, o.IZX, 6), m("NOP", o.NOP, o.IMM, 2), m("???", o.XXX, o.IMP, 8),
            m("CPY", o.CPY, o.ZP0, 3), m("CMP", o.CMP, o.ZP0, 3), m("DEC", o.DEC, o.ZP0, 5), m("???", o.XXX, o.IMP, 5),
            m("INY", o.INY, o.IMP, 2), m("CMP", o.CMP, o.IMM, 2), m("DEX", o.DEX, o.IMP, 2), m("???", o.XXX, o.IMP, 2),
            m("CPY", o.CPY, o.ABS, 4), m("CMP", o.CMP, o.ABS, 4), m("DEC", o.DEC, o.ABS, 6), m("???", o.XXX, o.IMP, 6),
            m("BNE", o.BNE, o.REL, 2), m("CMP", o.CMP, o.IZY, 5), m("???", o.XXX, o.IMP, 2), m("???", o.XXX, o.IMP, 8),
            m("NOP", o.NOP, o.ZPX, 4), m("CMP", o.CMP, o.ZPX, 4), m("DEC", o.DEC, o.ZPX, 6), m("???", o.XXX, o.IMP, 6),
            m("CLD", o.CLD, o.IMP, 2), m("CMP", o.CMP, o.ABY, 4), m("NOP", o.NOP, o.IMP, 2), m("???", o.XXX, o.IMP, 7),
            m("NOP", o.NOP, o.ABX, 4), m("CMP", o.CMP, o.ABX, 4), m("DEC", o.DEC, o.ABX, 7), m("???", o.XXX, o.IMP, 7),
            m("CPX", o.CPX, o.IMM, 2), m("SBC", o.SBC, o.IZX, 6), m("NOP", o.NOP, o.IMM, 2), m("???", o.XXX, o.IMP, 8),
            m("CPX", o.CPX, o.ZP0, 3), m("SBC", o.SBC, o.ZP0, 3), m("INC", o.INC, o.ZP0, 5), m("???", o.XXX, o.IMP, 5),
            m("INX", o.INX, o.IMP, 2), m("SBC", o.SBC, o.IMM, 2), m("NOP", o.NOP, o.IMP, 2), m("SBC", o.SBC, o.IMM, 2),
            m("CPX", o.CPX, o.ABS, 4), m("SBC", o.SBC, o.ABS, 4), m("INC", o.INC, o.ABS, 6), m("???", o.XXX, o.IMP, 6),
            m("BEQ", o.BEQ, o.REL, 2), m("SBC", o.SBC, o.IZY, 5), m("???", o.XXX, o.IMP, 2), m("???", o.XXX, o.IMP, 8),
            m("NOP", o.NOP, o.ZPX, 4), m("SBC", o.SBC, o.ZPX, 4), m("INC", o.INC, o.ZPX, 6), m("???", o.XXX, o.IMP, 6),
            m("SED", o.SED, o.IMP, 2), m("SBC", o.SBC, o.ABY, 4), m("NOP", o.NOP, o.IMP, 2), m("???", o.XXX, o.IMP, 7),
            m("NOP", o.NOP, o.ABX, 4), m("SBC", o.SBC, o.ABX, 4), m("INC", o.INC, o.ABX, 7), m("???", o.XXX, o.IMP, 7)
        ];
    }

    // Debug: get current state as string
    getState() {
        return `PC:${this.pc.toString(16).padStart(4, '0')} A:${this.a.toString(16).padStart(2, '0')} X:${this.x.toString(16).padStart(2, '0')} Y:${this.y.toString(16).padStart(2, '0')} SP:${this.sp.toString(16).padStart(2, '0')} P:${this.getStatus().toString(16).padStart(2, '0')}`;
    }
}
