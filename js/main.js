// NES Emulator - Main Entry Point

import { Bus } from './bus.js';
import { CPU } from './cpu.js';
import { PPU } from './ppu.js';
import { APU } from './apu.js';
import { Cartridge } from './cartridge.js';
import { Controller } from './controller.js';

class NESEmulator {
    constructor() {
        // Core components
        this.bus = new Bus();
        this.cpu = new CPU(this.bus);
        this.ppu = new PPU(this.bus);
        this.apu = new APU(this.bus);
        this.controller = new Controller(this.bus);

        // Connect components
        this.bus.connectCPU(this.cpu);
        this.bus.connectPPU(this.ppu);
        this.bus.connectAPU(this.apu);

        // Canvas
        this.canvas = document.getElementById('screen');
        this.ctx = this.canvas.getContext('2d');
        this.imageData = this.ctx.createImageData(256, 240);

        // State
        this.running = false;
        this.romLoaded = false;
        this.lastFrameTime = 0;
        this.frameCount = 0;
        this.fps = 0;

        this.setupUI();
        this.drawStartScreen();
    }

    setupUI() {
        // ROM input
        const romInput = document.getElementById('rom-input');
        romInput.addEventListener('change', (e) => this.loadROM(e.target.files[0]));

        // Buttons
        document.getElementById('btn-start').addEventListener('click', () => this.start());
        document.getElementById('btn-pause').addEventListener('click', () => this.pause());
        document.getElementById('btn-reset').addEventListener('click', () => this.reset());
    }

    async loadROM(file) {
        if (!file) return;

        try {
            const arrayBuffer = await file.arrayBuffer();
            const romData = new Uint8Array(arrayBuffer);

            const cartridge = new Cartridge(romData);
            if (!cartridge.valid) {
                alert('Invalid or unsupported ROM file');
                return;
            }

            this.bus.insertCartridge(cartridge);
            this.bus.reset();

            this.romLoaded = true;
            document.getElementById('rom-name').textContent = file.name;
            document.getElementById('btn-start').disabled = false;
            document.getElementById('btn-reset').disabled = false;

            // Draw first frame
            this.runFrame();
            this.render();

        } catch (error) {
            console.error('Error loading ROM:', error);
            alert('Failed to load ROM: ' + error.message);
        }
    }

    start() {
        if (!this.romLoaded) return;

        // Initialize audio (requires user interaction)
        this.apu.init();

        this.running = true;
        document.getElementById('btn-start').disabled = true;
        document.getElementById('btn-pause').disabled = false;
        document.querySelector('.screen-frame').classList.add('running');

        this.lastFrameTime = performance.now();
        this.frameCount = 0;
        this.gameLoop();
    }

    pause() {
        this.running = false;
        document.getElementById('btn-start').disabled = false;
        document.getElementById('btn-pause').disabled = true;
        document.querySelector('.screen-frame').classList.remove('running');
    }

    reset() {
        this.pause();
        this.bus.reset();
        this.runFrame();
        this.render();
    }

    gameLoop() {
        if (!this.running) return;

        const startTime = performance.now();

        // Update controller
        this.controller.update();

        // Run one frame
        this.runFrame();

        // Render
        this.render();

        // FPS calculation
        this.frameCount++;
        const elapsed = startTime - this.lastFrameTime;
        if (elapsed >= 1000) {
            this.fps = Math.round(this.frameCount * 1000 / elapsed);
            this.frameCount = 0;
            this.lastFrameTime = startTime;
        }

        // Update debug info
        this.updateDebug();

        // Schedule next frame (~60 FPS)
        requestAnimationFrame(() => this.gameLoop());
    }

    runFrame() {
        // Run until PPU completes a frame
        this.ppu.frameComplete = false;
        while (!this.ppu.frameComplete) {
            this.bus.clock();
        }
    }

    render() {
        // Copy PPU frame buffer to canvas
        this.imageData.data.set(this.ppu.frameBuffer);
        this.ctx.putImageData(this.imageData, 0, 0);
    }

    updateDebug() {
        document.getElementById('debug-cpu').textContent = this.cpu.getState();
        document.getElementById('debug-ppu').textContent = this.ppu.getState();
        document.getElementById('debug-fps').textContent = this.fps;
    }

    drawStartScreen() {
        this.ctx.fillStyle = '#1a1a2e';
        this.ctx.fillRect(0, 0, 256, 240);

        this.ctx.fillStyle = '#ff4757';
        this.ctx.font = 'bold 16px "Press Start 2P", monospace';
        this.ctx.textAlign = 'center';
        this.ctx.fillText('NES', 128, 100);

        this.ctx.fillStyle = '#8888a0';
        this.ctx.font = '8px "Press Start 2P", monospace';
        this.ctx.fillText('Load a ROM to start', 128, 140);
    }
}

// Initialize emulator when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.nes = new NESEmulator();
});
