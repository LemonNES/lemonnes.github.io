/**
 * nes_core.js — LemonNES Emulator Core
 */
console.log("nes_core.js loaded");
(function (global) {
  'use strict';

  // ── Internal Settings (controlled via public API, not HTML toggles) ────────
  const Settings = {
    input:     { keyboard: false, touch: false, gamepad: false }, // Android controls input
    audio:     { enabled: true, volume: 0.5 },
    display:   { integerScale: true, scanlines: false },
    emulation: { speed: 1 }
  };

  // ===== APU Timing Constants =====
  const CPU_FREQ = 1789773;
  const AUDIO_SAMPLE_RATE = 44100;
  const CYCLES_PER_SAMPLE = CPU_FREQ / AUDIO_SAMPLE_RATE;
  const NTSC_FPS = 60.0988;
  const CPU_CYCLES_PER_FRAME = Math.round(CPU_FREQ / NTSC_FPS);
  // ===== Utilities =====
  const clamp=(v,min,max)=>v<min?min:v>max?max:v;
  const u8 = n => n & 0xFF;
  const u16 = n => n & 0xFFFF;
  const toHex=(n,len=2)=>('0'.repeat(len)+n.toString(16).toUpperCase()).slice(-len);

  // ===== Controllers =====
  class Controllers{
    constructor(){
      this.state1=0; this.state2=0; this.latch=0; this.shift1=0;
      this.shift2=0;
      this.keyMap = { 'KeyZ':0, 'KeyX':1, 'ShiftRight':2, 'Enter':3, 'ArrowUp':4,'ArrowDown':5,'ArrowLeft':6,'ArrowRight':7 };
      this.buttonMap = { 'a':0, 'b':1, 'select':2, 'start':3, 'up':4, 'down':5, 'left':6, 'right':7 };
      this.bindKeys();
    }
    bindKeys(){
      window.addEventListener('keydown',e=>{
        if(e.repeat) return;
        if(!Settings.input.keyboard) return;
        if(this.keyMap[e.code]!==undefined){ this.state1 |= (1<<this.keyMap[e.code]); e.preventDefault(); }
      });
      window.addEventListener('keyup',e=>{
        if(!Settings.input.keyboard) return;
        if(this.keyMap[e.code]!==undefined){ this.state1 &= ~(1<<this.keyMap[e.code]); e.preventDefault(); }
      });
    }
    setButton(player, button, pressed) {
      if(player !== 0) return;
      const bit = this.buttonMap[button];
      if(bit === undefined) {
        console.warn('Unknown button:', button);
        return;
      }
      if(pressed) {
        this.state1 |= (1 << bit);
      } else {
        this.state1 &= ~(1 << bit);
      }
    }
    handleKeyEvent(code, pressed) {
      const bit = this.keyMap[code];
      if(bit === undefined) return;
      if(pressed) {
        this.state1 |= (1 << bit);
      } else {
        this.state1 &= ~(1 << bit);
      }
    }
    write(v){ this.latch = v & 1; if(this.latch){ this.shift1=this.state1; this.shift2=this.state2; }}
    read1(){ const out = this.shift1 & 1; if(!this.latch) this.shift1 = (this.shift1>>>1)|0x80; return out; }
    read2(){ const out = this.shift2 & 1; if(!this.latch) this.shift2 = (this.shift2>>>1)|0x80; return out; }
  }

  // === APU ===
  class APU {
    constructor() {
      this.audioCtx = null; this.scriptNode = null; this.audioBuffer = []; this.bufferSize = 2048;
      this.cpuCycleAccumulator = 0; this.frameCounter = 0; this.frameMode = 0; this.irqInhibit = false;
      this.frameIRQ = false; this.frameSequencerCycle = 0;
      this.pulse1 = this.createPulseChannel(); this.pulse2 = this.createPulseChannel();
      this.triangle = this.createTriangleChannel(); this.noise = this.createNoiseChannel(); this.dmc = this.createDMCChannel();
      this.totalCycles = 0; this.initAudio();
      this.lengthTable = [10,254, 20, 2, 40, 4, 80, 6, 160, 8, 60, 10, 14, 12, 26, 14, 12, 16, 24, 18, 48, 20, 96, 22, 192, 24, 72, 26, 16, 28, 32, 30];
      this.noiseTable = [4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068];
      this.dmcTable = [428, 380, 340, 320, 286, 254, 226, 214, 190, 160, 142, 128, 106, 84, 72, 54];
    }
    initAudio() {
      try {
        this.audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: AUDIO_SAMPLE_RATE });
        this.scriptNode = this.audioCtx.createScriptProcessor(this.bufferSize, 0, 1);
        this.scriptNode.onaudioprocess = (e) => {
          const output = e.outputBuffer.getChannelData(0);
          for (let i = 0; i < output.length; i++) {
            output[i] = this.audioBuffer.length > 0 ? this.audioBuffer.shift() : 0;
          }
        };
        this.scriptNode.connect(this.audioCtx.destination);
        window.__lemonAudioCtx = this.audioCtx;
        const resumeAudio = () => { if (this.audioCtx.state === 'suspended') { this.audioCtx.resume(); } };
        document.addEventListener('click', resumeAudio, { once: true });
        document.addEventListener('touchstart', resumeAudio, { once: true });
      } catch (e) { console.warn('Audio init failed:', e); }
    }
    createPulseChannel() { return { enabled: false, lengthCounter: 0, lengthHalt: false, constantVolume: false, volume: 0, duty: 0, dutyPos: 0, timer: 0, timerPeriod: 0, timerCycle: 0, sweepEnabled: false, sweepPeriod: 0, sweepNegate: false, sweepShift: 0, sweepReload: false, sweepCounter: 0, envelopeStart: false, envelopeCounter: 0, envelopeVolume: 0, envelopePeriod: 0, output: 0 }; }
    createTriangleChannel() { return { enabled: false, lengthCounter: 0, lengthHalt: false, timer: 0, timerPeriod: 0, timerCycle: 0, linearCounter: 0, linearCounterReload: 0, linearCounterControl: false, linearReloadFlag: false, sequencePos: 0, output: 0 }; }
    createNoiseChannel() { return { enabled: false, lengthCounter: 0, lengthHalt: false, constantVolume: false, volume: 0, timer: 0, timerPeriod: 0, timerCycle: 0, mode: false, shiftRegister: 1, envelopeStart: false, envelopeCounter: 0, envelopeVolume: 0, envelopePeriod: 0, output: 0 }; }
    createDMCChannel() { return { enabled: false, irqEnabled: false, loop: false, timer: 0, timerPeriod: 0, timerCycle: 0, output: 0, sampleAddress: 0, sampleLength: 0, currentAddress: 0, bytesRemaining: 0, sampleBuffer: 0, sampleBufferEmpty: true, shiftRegister: 0, bitsRemaining: 0, silence: true }; }
    step(cpuCycles) {
      this.totalCycles += cpuCycles; this.stepFrameSequencer(cpuCycles);
      for (let i = 0; i < cpuCycles; i++) {
        if ((this.totalCycles + i) % 2 === 0) { this.stepPulseTimer(this.pulse1); this.stepPulseTimer(this.pulse2); this.stepNoiseTimer(this.noise); }
        this.stepTriangleTimer(this.triangle); this.stepDMCTimer(this.dmc);
      }
      this.cpuCycleAccumulator += cpuCycles;
      while (this.cpuCycleAccumulator >= CYCLES_PER_SAMPLE) {
        this.cpuCycleAccumulator -= CYCLES_PER_SAMPLE;
        const sample = this.mixOutput();
        this.audioBuffer.push(sample * (Settings.audio.enabled ? 1 : 0) * Settings.audio.volume);
        if (this.audioBuffer.length > this.bufferSize * 3) { this.audioBuffer = this.audioBuffer.slice(-this.bufferSize * 2); }
      }
    }
    stepFrameSequencer(cpuCycles) {
      this.frameSequencerCycle += cpuCycles; const FRAME_COUNTER_PERIOD = 7457.5;
      while (this.frameSequencerCycle >= FRAME_COUNTER_PERIOD) {
        this.frameSequencerCycle -= FRAME_COUNTER_PERIOD;
        if (this.frameMode === 0) {
          switch (this.frameCounter) {
            case 0: case 2: this.clockEnvelopes(); this.clockTriangleLinearCounter(); break;
            case 1: this.clockEnvelopes(); this.clockTriangleLinearCounter(); this.clockLengthCounters(); this.clockSweeps(); break;
            case 3: this.clockEnvelopes(); this.clockTriangleLinearCounter(); this.clockLengthCounters(); this.clockSweeps(); if (!this.irqInhibit) this.frameIRQ = true; break;
          }
          this.frameCounter = (this.frameCounter + 1) % 4;
        } else {
          switch (this.frameCounter) {
            case 0: case 2: this.clockEnvelopes(); this.clockTriangleLinearCounter(); break;
            case 1: case 3: this.clockEnvelopes(); this.clockTriangleLinearCounter(); this.clockLengthCounters(); this.clockSweeps(); break;
          }
          this.frameCounter = (this.frameCounter + 1) % 5;
        }
      }
    }
    stepPulseTimer(pulse) {
      pulse.timerCycle++;
      if (pulse.timerCycle >= pulse.timerPeriod + 1) {
        pulse.timerCycle = 0;
        pulse.dutyPos = (pulse.dutyPos + 1) % 8;
      }
    }
    stepTriangleTimer(triangle) { if (triangle.lengthCounter > 0 && triangle.linearCounter > 0) { triangle.timerCycle++; if (triangle.timerCycle >= triangle.timerPeriod + 1) { triangle.timerCycle = 0; triangle.sequencePos = (triangle.sequencePos + 1) % 32; } } this.updateTriangleOutput(triangle); }
    stepNoiseTimer(noise) { noise.timerCycle++; if (noise.timerCycle >= noise.timerPeriod + 1) { noise.timerCycle = 0; const feedback = noise.mode ? ((noise.shiftRegister >> 6) & 1) ^ (noise.shiftRegister & 1) : ((noise.shiftRegister >> 1) & 1) ^ (noise.shiftRegister & 1); noise.shiftRegister = (noise.shiftRegister >> 1) | (feedback << 14); } this.updateNoiseOutput(noise); }
    stepDMCTimer(dmc) { if (dmc.enabled && dmc.bytesRemaining > 0) { dmc.timerCycle++; if (dmc.timerCycle >= dmc.timerPeriod + 1) { dmc.timerCycle = 0; } } }
    updatePulseOutput(pulse, isChannel2) {
      if (!pulse.enabled || pulse.lengthCounter === 0 || pulse.timerPeriod < 8 || this.isSweepMuting(pulse, isChannel2)) { pulse.output = 0; return; }
      const dutyTable = [[0,1,0,0,0,0,0,0], [0,1,1,0,0,0,0,0], [0,1,1,1,1,0,0,0], [1,0,0,1,1,1,1,1]];
      pulse.output = dutyTable[pulse.duty][pulse.dutyPos] * (pulse.constantVolume ? pulse.volume : pulse.envelopeVolume);
    }
    isSweepMuting(pulse, isChannel2) {
      if (!pulse.sweepEnabled || pulse.sweepShift === 0) return false;
      const delta = pulse.timerPeriod >> pulse.sweepShift;
      let targetPeriod;
      if (pulse.sweepNegate) {
        targetPeriod = pulse.timerPeriod - delta - (isChannel2 ? 0 : 1);
      } else {
        targetPeriod = pulse.timerPeriod + delta;
      }
      return targetPeriod > 0x7FF;
    }
    updateTriangleOutput(triangle) { if (!triangle.enabled || triangle.lengthCounter === 0 || triangle.linearCounter === 0) { triangle.output = 0; return; } const seq = [15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15]; triangle.output = seq[triangle.sequencePos]; }
    updateNoiseOutput(noise) { if (!noise.enabled || noise.lengthCounter === 0 || (noise.shiftRegister & 1)) { noise.output = 0; return; } noise.output = (noise.constantVolume ? noise.volume : noise.envelopeVolume); }
    clockEnvelopes() { this.clockEnvelope(this.pulse1); this.clockEnvelope(this.pulse2); this.clockEnvelope(this.noise); }
    clockEnvelope(ch) { if (ch.envelopeStart) { ch.envelopeStart = false; ch.envelopeVolume = 15; ch.envelopeCounter = ch.envelopePeriod; } else { if (ch.envelopeCounter === 0) { ch.envelopeCounter = ch.envelopePeriod; if (ch.envelopeVolume > 0) ch.envelopeVolume--; else if (ch.lengthHalt) ch.envelopeVolume = 15; } else { ch.envelopeCounter--; } } }
    clockLengthCounters() { if (this.pulse1.lengthCounter > 0 && !this.pulse1.lengthHalt) this.pulse1.lengthCounter--; if (this.pulse2.lengthCounter > 0 && !this.pulse2.lengthHalt) this.pulse2.lengthCounter--; if (this.triangle.lengthCounter > 0 && !this.triangle.lengthHalt) this.triangle.lengthCounter--; if (this.noise.lengthCounter > 0 && !this.noise.lengthHalt) this.noise.lengthCounter--; }
    clockTriangleLinearCounter() { if (this.triangle.linearReloadFlag) { this.triangle.linearCounter = this.triangle.linearCounterReload; } else if (this.triangle.linearCounter > 0) { this.triangle.linearCounter--; } if (!this.triangle.linearCounterControl) { this.triangle.linearReloadFlag = false; } }
    clockSweeps() { this.clockSweep(this.pulse1, false); this.clockSweep(this.pulse2, true); }
    clockSweep(pulse, isChannel2) {
      let shouldUpdate = false;

      if (pulse.sweepReload) {
        pulse.sweepCounter = pulse.sweepPeriod;
        pulse.sweepReload = false;
        if (pulse.sweepCounter === 0) shouldUpdate = true;
      } else if (pulse.sweepCounter > 0) {
        pulse.sweepCounter--;
        if (pulse.sweepCounter === 0) shouldUpdate = true;
      } else {
        shouldUpdate = true;
        pulse.sweepCounter = pulse.sweepPeriod;
      }

      if (shouldUpdate && pulse.sweepEnabled && pulse.sweepShift > 0 && pulse.timerPeriod >= 8) {
        const delta = pulse.timerPeriod >> pulse.sweepShift;
        let newPeriod;
        if (pulse.sweepNegate) {
          newPeriod = pulse.timerPeriod - delta - (isChannel2 ? 0 : 1);
        } else {
          newPeriod = pulse.timerPeriod + delta;
        }
        if (newPeriod >= 8 && newPeriod <= 0x7FF) {
          pulse.timerPeriod = newPeriod;
          if (pulse.timerCycle > pulse.timerPeriod) pulse.timerCycle = 0;
        } else {
          pulse.lengthCounter = 0;
        }
      }
    }
    mixOutput() {
      this.updatePulseOutput(this.pulse1, false);
      this.updatePulseOutput(this.pulse2, true);
      const p1 = this.pulse1.output, p2 = this.pulse2.output; const tri = this.triangle.output, noi = this.noise.output, dmc = this.dmc.output;
      let pulseOut = (p1 + p2 > 0) ? 95.88 / ((8128.0 / (p1 + p2)) + 100) : 0;
      let tndOut = (tri + 2*noi + dmc > 0) ? 159.79 / ((1.0 / (tri/8227.0 + noi/12241.0 + dmc/22638.0)) + 100) : 0;
      return (pulseOut + tndOut) * 0.5;
    }
    write(addr, val) {
      switch (addr) {
        case 0x4000: this.pulse1.duty = (val >> 6) & 3; this.pulse1.lengthHalt = !!(val & 0x20); this.pulse1.constantVolume = !!(val & 0x10); this.pulse1.volume = val & 0x0F; this.pulse1.envelopePeriod = val & 0x0F; break;
        case 0x4001: this.pulse1.sweepEnabled = !!(val & 0x80); this.pulse1.sweepPeriod = (val >> 4) & 7; this.pulse1.sweepNegate = !!(val & 0x08); this.pulse1.sweepShift = val & 7; this.pulse1.sweepReload = true; break;
        case 0x4002: this.pulse1.timerPeriod = (this.pulse1.timerPeriod & 0x700) | val; if (this.pulse1.timerCycle > this.pulse1.timerPeriod) this.pulse1.timerCycle = 0; break;
        case 0x4003: this.pulse1.timerPeriod = (this.pulse1.timerPeriod & 0xFF) | ((val & 7) << 8); if (this.pulse1.enabled) this.pulse1.lengthCounter = this.lengthTable[val >> 3]; this.pulse1.envelopeStart = true; if (this.pulse1.timerCycle > this.pulse1.timerPeriod) this.pulse1.timerCycle = 0; break;
        case 0x4004: this.pulse2.duty = (val >> 6) & 3; this.pulse2.lengthHalt = !!(val & 0x20); this.pulse2.constantVolume = !!(val & 0x10); this.pulse2.volume = val & 0x0F; this.pulse2.envelopePeriod = val & 0x0F; break;
        case 0x4005: this.pulse2.sweepEnabled = !!(val & 0x80); this.pulse2.sweepPeriod = (val >> 4) & 7; this.pulse2.sweepNegate = !!(val & 0x08); this.pulse2.sweepShift = val & 7; this.pulse2.sweepReload = true; break;
        case 0x4006: this.pulse2.timerPeriod = (this.pulse2.timerPeriod & 0x700) | val; if (this.pulse2.timerCycle > this.pulse2.timerPeriod) this.pulse2.timerCycle = 0; break;
        case 0x4007: this.pulse2.timerPeriod = (this.pulse2.timerPeriod & 0xFF) | ((val & 7) << 8); if (this.pulse2.enabled) this.pulse2.lengthCounter = this.lengthTable[val >> 3]; this.pulse2.envelopeStart = true; if (this.pulse2.timerCycle > this.pulse2.timerPeriod) this.pulse2.timerCycle = 0; break;
        case 0x4008: this.triangle.linearCounterControl = !!(val & 0x80); this.triangle.lengthHalt = !!(val & 0x80); this.triangle.linearCounterReload = val & 0x7F; break;
        case 0x400A: this.triangle.timerPeriod = (this.triangle.timerPeriod & 0x700) | val; if (this.triangle.timerCycle > this.triangle.timerPeriod) this.triangle.timerCycle = 0; break;
        case 0x400B: this.triangle.timerPeriod = (this.triangle.timerPeriod & 0xFF) | ((val & 7) << 8); if (this.triangle.enabled) this.triangle.lengthCounter = this.lengthTable[val >> 3]; this.triangle.linearReloadFlag = true; if (this.triangle.timerCycle > this.triangle.timerPeriod) this.triangle.timerCycle = 0; break;
        case 0x400C: this.noise.lengthHalt = !!(val & 0x20); this.noise.constantVolume = !!(val & 0x10); this.noise.volume = val & 0x0F; this.noise.envelopePeriod = val & 0x0F; break;
        case 0x400E: this.noise.mode = !!(val & 0x80); this.noise.timerPeriod = this.noiseTable[val & 0x0F]; break;
        case 0x400F: if (this.noise.enabled) this.noise.lengthCounter = this.lengthTable[val >> 3]; this.noise.envelopeStart = true; break;
        case 0x4010: this.dmc.irqEnabled = !!(val & 0x80); this.dmc.loop = !!(val & 0x40); this.dmc.timerPeriod = this.dmcTable[val & 0x0F]; break;
        case 0x4011: this.dmc.output = val & 0x7F; break;
        case 0x4012: this.dmc.sampleAddress = 0xC000 | (val << 6); break;
        case 0x4013: this.dmc.sampleLength = (val << 4) | 1; break;
        case 0x4015:
          this.pulse1.enabled = !!(val & 0x01); this.pulse2.enabled = !!(val & 0x02); this.triangle.enabled = !!(val & 0x04); this.noise.enabled = !!(val & 0x08); this.dmc.enabled = !!(val & 0x10);
          if (!this.pulse1.enabled) this.pulse1.lengthCounter = 0; if (!this.pulse2.enabled) this.pulse2.lengthCounter = 0;
          if (!this.triangle.enabled) this.triangle.lengthCounter = 0; if (!this.noise.enabled) this.noise.lengthCounter = 0;
          break;
        case 0x4017:
          this.frameMode = (val >> 7) & 1; this.irqInhibit = !!(val & 0x40); if (this.irqInhibit) this.frameIRQ = false;
          this.frameCounter = 0; this.frameSequencerCycle = 0;
          if (this.frameMode === 1) { this.clockEnvelopes(); this.clockTriangleLinearCounter(); this.clockLengthCounters(); this.clockSweeps(); }
          break;
      }
    }
    read(addr) {
      if (addr === 0x4015) {
        const status = (this.pulse1.lengthCounter > 0 ? 0x01 : 0) | (this.pulse2.lengthCounter > 0 ? 0x02 : 0) | (this.triangle.lengthCounter > 0 ? 0x04 : 0) | (this.noise.lengthCounter > 0 ? 0x08 : 0) | (this.dmc.bytesRemaining > 0 ? 0x10 : 0) | (this.frameIRQ ? 0x40 : 0) | (this.dmc.irqEnabled ? 0x80 : 0);
        this.frameIRQ = false; return status;
      }
      return 0;
    }
  }

  // ===== Mappers =====
  class Mapper { constructor(cart) { this.cart = cart; } prgRead(addr) { return 0; } prgWrite(addr, val) { } chrRead(addr) { return 0; } chrWrite(addr, val) { } ppuCycle() {} }
  class Mapper0 extends Mapper {
    constructor(cart) { super(cart); this.prgMask = (cart.prg.length > 0x4000) ? 0x7FFF : 0x3FFF; }
    prgRead(addr) { return this.cart.prg[(addr - 0x8000) & this.prgMask]; }
    prgWrite(addr, val) { }
    chrRead(addr) { return this.cart.chr[addr]; }
    chrWrite(addr, val) { if (!this.cart.chrROM) { this.cart.chr[addr] = val; } }
  }
  class Mapper1 extends Mapper {
  constructor(c) {
    super(c);
    this.shift = 0x10;
    this.ctrl = 0x0C;  // Initialize with bits 2-3 set (PRG mode 3)
    this.prgBank = 0;
    this.chrBank0 = 0;
    this.chrBank1 = 0;
    this.prgRAM = new Uint8Array(0x2000); // 8KB PRG RAM
    this.ppu = null; // Reference to PPU for mirroring updates
  }

 writeReg(addr, val) {
  if (val & 0x80) {
    this.shift = 0x10;
    this.ctrl |= 0x0C;
    return;
  }

  const carry = this.shift & 1;

  this.shift >>= 1;
  this.shift |= (val & 1) << 4;

  if (carry) {
    const reg = (addr >> 13) & 3;
    const data = this.shift & 0x1F;

    this.shift = 0x10;

    switch (reg) {
      case 0:
        this.ctrl = data;

        const mirror = data & 3;
        if (mirror === 0) this.cart.mirror = 'single0';
        else if (mirror === 1) this.cart.mirror = 'single1';
        else if (mirror === 2) this.cart.mirror = 'vertical';
        else this.cart.mirror = 'horizontal';

        if (this.ppu) this.ppu.mirror = this.cart.mirror;
        break;

      case 1:
        this.chrBank0 = data;
        break;

      case 2:
        this.chrBank1 = data;
        break;

      case 3:
        this.prgBank = data & 0x0F;
        break;
    }
  }
}

  prgRead(addr) {
    // PRG RAM at $6000-$7FFF
    if (addr >= 0x6000 && addr < 0x8000) {
      return this.prgRAM[addr - 0x6000];
    }

    const mode = (this.ctrl >> 2) & 3;
    const prgSize = this.cart.prg.length;

    if (mode === 0 || mode === 1) {
      const bank32 = (this.prgBank >> 1);
      const offset = (bank32 * 0x8000) + (addr - 0x8000);
      return this.cart.prg[offset % prgSize];
    }
    else if (mode === 2) {
      if (addr < 0xC000) {
        return this.cart.prg[(addr - 0x8000) % prgSize];
      } else {
        const offset = (this.prgBank * 0x4000) + (addr - 0xC000);
        return this.cart.prg[offset % prgSize];
      }
    }
    else {
      if (addr < 0xC000) {
        const offset = (this.prgBank * 0x4000) + (addr - 0x8000);
        return this.cart.prg[offset % prgSize];
      } else {
        const lastBankOffset = prgSize - 0x4000;
        return this.cart.prg[lastBankOffset + (addr - 0xC000)];
      }
    }
  }

  prgWrite(addr, val) {
    if (addr >= 0x6000 && addr < 0x8000) {
      // PRG RAM write
      this.prgRAM[addr - 0x6000] = val;
    } else {
      this.writeReg(addr, val);
    }
  }

  chrRead(addr) {
    const chrSize = this.cart.chr.length;

    if (chrSize === 0) return 0;

    const mode = (this.ctrl >> 4) & 1;

    if (mode === 0) {
      const bank8 = (this.chrBank0 >> 1);
      const offset = (bank8 * 0x2000) + addr;
      return this.cart.chr[offset % chrSize];
    } else {
      if (addr < 0x1000) {
        const offset = (this.chrBank0 * 0x1000) + addr;
        return this.cart.chr[offset % chrSize];
      } else {
        const offset = (this.chrBank1 * 0x1000) + (addr - 0x1000);
        return this.cart.chr[offset % chrSize];
      }
    }
  }

  chrWrite(addr, val) {
    if (!this.cart.chrROM) {
      const chrSize = this.cart.chr.length;

      if (chrSize === 0) return;

      const mode = (this.ctrl >> 4) & 1;

      if (mode === 0) {
        const bank8 = (this.chrBank0 >> 1);
        const offset = (bank8 * 0x2000) + addr;
        this.cart.chr[offset % chrSize] = val;
      } else {
        if (addr < 0x1000) {
          const offset = (this.chrBank0 * 0x1000) + addr;
          this.cart.chr[offset % chrSize] = val;
        } else {
          const offset = (this.chrBank1 * 0x1000) + (addr - 0x1000);
          this.cart.chr[offset % chrSize] = val;
        }
      }
    }
  }
}

class Mapper2 extends Mapper {
  constructor(c) {
    super(c);
    this.bank = 0;
    this.numBanks = Math.floor(c.prg.length / 0x4000);
  }

  prgRead(addr) {
    if (addr < 0xC000) {
      const bankNum = this.bank % this.numBanks;
      const base = bankNum * 0x4000;
      return this.cart.prg[base + (addr - 0x8000)];
    }
    // Fixed last 16KB bank at $C000-$FFFF
    const lastBankOffset = this.cart.prg.length - 0x4000;
    return this.cart.prg[lastBankOffset + (addr - 0xC000)];
  }

  prgWrite(addr, val) {
    this.bank = val & 0x0F;
  }

  chrRead(addr) {
    // Mapper 2 uses CHR RAM, not ROM
    return this.cart.chr[addr & 0x1FFF];
  }

  chrWrite(addr, val) {
    // CHR RAM is always writable on Mapper 2
    this.cart.chr[addr & 0x1FFF] = val;
  }
}
class Mapper3 extends Mapper {
  constructor(c) {
    super(c);
    this.chrBank = 0;
  }

  prgRead(addr) {
    // PRG ROM is not banked - either 16KB or 32KB
    const prgMask = (this.cart.prg.length > 0x4000) ? 0x7FFF : 0x3FFF;
    return this.cart.prg[(addr - 0x8000) & prgMask];
  }

  prgWrite(addr, val) {
    // Bank select register - lower 2 bits select 8KB CHR bank
    this.chrBank = val & 0x03;
  }

  chrRead(addr) {
    // Switchable 8KB CHR bank
    const base = this.chrBank * 0x2000;
    return this.cart.chr[base + addr];
  }

  chrWrite(addr, val) {
    // CHR ROM is typically read-only, but support CHR RAM if present
    if (!this.cart.chrROM) {
      const base = this.chrBank * 0x2000;
      this.cart.chr[base + addr] = val;
    }
  }
}
 class Mapper4 extends Mapper {
    constructor(cart) {
        super(cart);
        this.cpu = null;
        this.ppu = null;

        this.bankSelect = 0;
        this.bankData = new Uint8Array(8);
        this.prgMode = 0;
        this.chrMode = 0;

        // ===== IRQ State =====
        this.irqLatch = 0;
        this.irqCounter = 0;
        this.irqEnable = false;   // IRQ enabled flag
        this.irqReloadPending = false;

        this.prgBanks = new Uint8Array(4);
        this.chrBanks = new Uint8Array(8);
        this.prgBanksTotal = this.cart.prg.length / 0x2000;
        this.lastBank = this.prgBanksTotal - 1;

        this.bankData.fill(0);

        this.updatePrgMapping();
        this.updateChrMapping();
    }

    // ===== PPU Cycle Hook - Scanline Counter =====
    ppuCycle() {
        if (!this.ppu) return;

        const renderingEnabled = (this.ppu.mask & 0x18) !== 0;
        if (!renderingEnabled) return;

        const scanline = this.ppu.scanline;
        const cycle = this.ppu.cycle;

        // Clock the counter at cycle 260 of visible scanlines (0-239)
        if (cycle === 260 && scanline >= 0 && scanline <= 239) {
            this.clockCounter();
        }
    }

    // ===== Scanline Counter Logic =====
    clockCounter() {
        if (this.irqReloadPending) {
            this.irqCounter = this.irqLatch;
            this.irqReloadPending = false;
            return;
        }

        if (this.irqCounter === 0) {
            this.irqCounter = this.irqLatch;
        } else {
            this.irqCounter--;
        }

        // ===== CRITICAL: Assert IRQ line when counter reaches 0 AND IRQ is enabled =====
        if (this.irqCounter === 0 && this.irqEnable && this.cpu) {
            this.cpu.irqLine = true;
        }
    }

    // ===== PRG ROM Access =====
    prgRead(addr) {
        if (addr >= 0x6000 && addr <= 0x7FFF) {
            if (!this.cart.sram) return 0;
            return this.cart.sram[addr - 0x6000];
        }
        let bankIdx = (addr - 0x8000) >> 13;
        let bank = this.prgBanks[bankIdx] % this.prgBanksTotal;
        return this.cart.prg[(bank * 0x2000) + (addr & 0x1FFF)];
    }

    prgWrite(addr, val) {
        if (addr >= 0x6000 && addr <= 0x7FFF) {
            this.cart.sram[addr - 0x6000] = val;
            return;
        }
        this.writeRegister(addr, val);
    }

    // ===== CHR ROM/RAM Access =====
    chrRead(addr) {
        let index = addr >> 10;
        let offset = addr & 0x3FF;
        let bankIndex = this.chrMode === 0 ? index : (index < 4 ? index + 4 : index - 4);
        let bank = this.chrBanks[bankIndex];
        const total = this.cart.chr.length >> 10;
        if (total > 0) bank %= total;
        return this.cart.chr[(bank * 1024) + offset];
    }

    chrWrite(addr, val) {
        if (this.cart.chrROM) return;
        let index = addr >> 10;
        let offset = addr & 0x3FF;
        let bankIndex = this.chrMode === 0 ? index : (index < 4 ? index + 4 : index - 4);
        let bank = this.chrBanks[bankIndex];
        const total = this.cart.chr.length >> 10;
        if (total > 0) bank %= total;
        this.cart.chr[(bank * 1024) + offset] = val;
    }

    // ===== Register Writes =====
    writeRegister(addr, val) {
        if (addr < 0x8000) return;

        if ((addr & 1) === 0) {
            if (addr < 0xA000) {
                this.bankSelect = val;
                const p = (val >> 6) & 1;  // PRG ROM bank mode
                const c = (val >> 7) & 1;  // CHR A12 inversion
                if (this.prgMode !== p) { this.prgMode = p; this.updatePrgMapping(); }
                if (this.chrMode !== c) { this.chrMode = c; this.updateChrMapping(); }
            } else if (addr < 0xC000) {
                if (this.ppu) this.ppu.mirror = (val & 1) ? 'horizontal' : 'vertical';
            } else if (addr < 0xE000) {
                // $C000-$DFFE: IRQ latch
                this.irqLatch = val;
            } else {
                // $E000-$FFFE: IRQ disable
                // ===== CRITICAL: Disable IRQ and CLEAR the IRQ line =====
                this.irqEnable = false;

  class Mapper9 extends Mapper {
  constructor(cart) {
    super(cart);
    // PRG ROM: 8KB banks
    // $A000-$FFFF are fixed to the last three 8KB banks
    this.numPrgBanks = Math.floor(cart.prg.length / 0x2000);
    this.prgBankSelect = 0;

    // CHR ROM: 4KB banks
    this.latch0 = 0;
    this.latch1 = 0;

    // Registers for CHR banks
    this.chrBanks = new Uint8Array(4);
    this.chrBanks.fill(0);
  }

  prgRead(addr) {
    // $6000-$7FFF: PRG RAM (if present)
    if (addr < 0x8000) return 0;

    let bankIndex = 0;
    const offset = addr & 0x1FFF;

    if (addr < 0xA000) {
      bankIndex = this.prgBankSelect;
    } else if (addr < 0xC000) {
      // $A000-$BFFF: Fixed to third last bank
      bankIndex = this.numPrgBanks - 3;
    } else if (addr < 0xE000) {
      // $C000-$DFFF: Fixed to second last bank
      bankIndex = this.numPrgBanks - 2;
    } else {
      // $E000-$FFFF: Fixed to last bank
      bankIndex = this.numPrgBanks - 1;
    }

    return this.cart.prg[(bankIndex * 0x2000 + offset) % this.cart.prg.length];
  }

  prgWrite(addr, val) {
    const reg = addr & 0xF000;

    switch (reg) {
      case 0xA000:
        // PRG ROM bank select ($8000-$9FFF)
        this.prgBankSelect = val & 0x0F;
        break;
      case 0xB000:
        // CHR ROM $FD/0 bank (Low 4KB, Latch=0)
        this.chrBanks[0] = val & 0x1F;
        break;
      case 0xC000:
        // CHR ROM $FE/0 bank (Low 4KB, Latch=1)
        this.chrBanks[1] = val & 0x1F;
        break;
      case 0xD000:
        // CHR ROM $FD/1 bank (High 4KB, Latch=0)
        this.chrBanks[2] = val & 0x1F;
        break;
      case 0xE000:
        // CHR ROM $FE/1 bank (High 4KB, Latch=1)
        this.chrBanks[3] = val & 0x1F;
        break;
      case 0xF000:
        if (this.ppu) {
          this.ppu.mirror = (val & 1) ? 'horizontal' : 'vertical';
        }
        break;
    }
  }

  chrRead(addr) {
    const bankSlot = (addr >> 12) & 1;

    const latchState = bankSlot === 0 ? this.latch0 : this.latch1;

    const bankIndex = this.chrBanks[(bankSlot * 2) + latchState];

    const result = this.cart.chr[(bankIndex * 0x1000) + (addr & 0xFFF)];

    // ===== LATCH UPDATE LOGIC =====

    if (addr === 0x0FD8) this.latch0 = 0;
    else if (addr === 0x0FE8) this.latch0 = 1;

    else if (addr >= 0x1FD8 && addr <= 0x1FDF) this.latch1 = 0;
    else if (addr >= 0x1FE8 && addr <= 0x1FEF) this.latch1 = 1;

    return result;
  }

  chrWrite(addr, val) {
    // MMC2 usually uses CHR ROM, but if RAM, we allow write
    if (!this.cart.chrROM) {
       this.cart.chr[addr] = val;
    }
  }
}

  // ===== Cartridge & Bus =====
  class Cartridge {
    constructor(bytes) {
      if (bytes[0] !== 0x4E || bytes[1] !== 0x45 || bytes[2] !== 0x53 || bytes[3] !== 0x1A) throw new Error('Invalid iNES ROM file');
      const prgBanks = bytes[4], chrBanks = bytes[5], f6 = bytes[6], f7 = bytes[7];
      this.mapper = (f7 & 0xF0) | (f6 >> 4); this.mirror = (f6 & 1) ? 'vertical' : 'horizontal'; if (f6 & 0x08) this.mirror = 'four';
      const hasTrainer = !!(f6 & 0x04); let offset = 16 + (hasTrainer ? 512 : 0);
      const prgSize = prgBanks * 16384; this.prg = bytes.slice(offset, offset + prgSize); offset += prgSize;
      this.chrROM = chrBanks > 0;
      if (this.chrROM) { const chrSize = chrBanks * 8192; this.chr = bytes.slice(offset, offset + chrSize); } else { this.chr = new Uint8Array(8192); }
      this.chrRAM = !this.chrROM; this.sram = new Uint8Array(0x2000);
    }
  }
  class Bus {
    constructor(cpu, ppu, cart, input, apu){ this.cpu=cpu; this.ppu=ppu; this.cart=cart; this.input=input; this.apu=apu; this.ram=new Uint8Array(0x800); }
    cpuRead(addr){ addr&=0xFFFF;
      if(addr<0x2000){return this.ram[addr&0x7FF];}
      if(addr<0x4000){return this.ppu.read(0x2000 + (addr&7));}
      if(addr===0x4015){return this.apu.read(addr);}
      if(addr===0x4016){return this.input.read1();}
      if(addr===0x4017){return this.input.read2();}
      if(addr>=0x8000){return this.ppu.mapper.prgRead(addr);}
      if(addr>=0x6000){return this.ppu.cart.sram[addr-0x6000];}
      return 0;
    }
    cpuWrite(addr,val){ addr&=0xFFFF; val&=0xFF; if(addr<0x2000){this.ram[addr&0x7FF]=val; return;}
      if(addr<0x4000){this.ppu.write(0x2000 + (addr&7), val); return;}
      if(addr===0x4014){ const page = val<<8; const buf = new Uint8Array(256); for(let i=0;i<256;i++) buf[i]=this.cpuRead(page+i); this.ppu.doDMA(buf); this.cpu.stall += 513 + (this.cpu.cycles%2===1?1:0); return;}
      if(addr===0x4016){this.input.write(val); return;}
      if(addr>=0x4000 && addr<=0x4017){ this.apu.write(addr,val); return; }
      if(addr>=0x8000){this.ppu.mapper.prgWrite(addr,val); return;}
      if(addr>=0x6000){this.ppu.cart.sram[addr-0x6000]=val; return;}
    }
  }

  class PPU {
    constructor() {
      this.v = 0; this.t = 0; this.x = 0; this.w = 0; this.ctrl = 0; this.mask = 0; this.status = 0; this.oamaddr = 0; this.buffered = 0; this.openBus = 0;
      this.oam = new Uint8Array(256); this.secOAM = new Uint8Array(32); this.spriteCount = 0; this.spriteZeroInLine = false; this.spriteZeroHit = false;
      this.cycle = 0; this.scanline = 261; this.frame = 0; this.nmi = false; this.frameComplete = false;
      this.cart = null; this.mapper = null; this.canvas = null; this.ctx = null; this.output = null;
      this.vram = new Uint8Array(0x800); this.palette = new Uint8Array(32); this.bgLatch = { lo: 0, hi: 0, pal: 0 }; this.oddFrame = false;
      this.bgShiftLo = 0; this.bgShiftHi = 0; this.bgAttrShiftLo = 0; this.bgAttrShiftHi = 0; this.bgNextTile = 0; this.bgNextAttr = 0;
      this.fineXLatch = 0;
    }
    attachCanvas(canvas) { this.canvas = canvas; this.ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: true }); this.output = this.ctx.createImageData(256, 240); }
    connectCart(cart) {
  this.cart = cart;

  // Mapper registry: Index matches iNES mapper ID
  const mappers = [
    Mapper0, Mapper1, Mapper2, Mapper3, null,
    null, null, null, null, Mapper9 // Index 9 = Mapper9
  ];

  const MapperClass = mappers[cart.mapper];

  // Fallback to Mapper0 if not found
  this.mapper = MapperClass ? new MapperClass(cart) : new Mapper0(cart);

  cart.mapperObj = this.mapper;

  // Set PPU references for mappers that need it (MMC1, MMC4, MMC2/Mapper9)
  if(this.mapper && (this.mapper instanceof Mapper1 || this.mapper instanceof Mapper4 || this.mapper instanceof Mapper9)) {
    this.mapper.ppu = this;
  }

  this.mirror = cart.mirror;
    }
    reset() { this.v = this.t = this.x = this.w = 0; this.ctrl = this.mask = this.status = this.oamaddr = 0; this.cycle = 0; this.scanline = 261; this.nmi = false; this.frame = 0; this.oddFrame = false; this.bgShiftLo = 0; this.bgShiftHi = 0; this.bgAttrShiftLo = 0; this.bgAttrShiftHi = 0; this.fineXLatch = 0; }
    read(addr) {
      switch (addr) {
        case 0x2002: { const res = (this.status & 0xE0) | (this.buffered & 0x1F); this.openBus = res; this.status &= ~0x80; this.w = 0; this.nmi = false; return res; }
        case 0x2004: return this.oam[this.oamaddr];
        case 0x2007: { let value = this.ppuRead(this.v); if (this.v < 0x3F00) { const temp = this.buffered; this.buffered = value; value = temp; } else { this.buffered = this.ppuRead(this.v - 0x1000); } this.v += (this.ctrl & 0x04) ? 32 : 1; this.v &= 0x7FFF; this.openBus = value; return value; }
        default: return this.openBus;
      }
    }
    write(addr, val) {
      switch (addr) {
        case 0x2000:
          const oldCtrl = this.ctrl; this.ctrl = val; this.t = (this.t & 0xf3ff) | ((val & 0x03) << 10);
          const nmiEnableWasOff = (oldCtrl & 0x80) === 0; const nmiEnableNowOn = (val & 0x80) !== 0; const vblankFlagSet = (this.status & 0x80) !== 0;
          if (nmiEnableWasOff && nmiEnableNowOn && vblankFlagSet) { this.nmi = true; } break;
        case 0x2001: this.mask = val; break;
        case 0x2003: this.oamaddr = val; break;
        case 0x2004: this.oam[this.oamaddr++] = val; break;
        case 0x2005: if (this.w === 0) { this.x = val & 0x07; this.t = (this.t & 0x7fe0) | ((val & 0xf8) >> 3); this.w = 1; } else { this.t = (this.t & 0x0c1f) | ((val & 0x07) << 12) | ((val & 0xf8) << 2); this.w = 0; } break;
        case 0x2006: if (this.w === 0) { this.t = (this.t & 0x00ff) | ((val & 0x3f) << 8); this.w = 1; } else { this.t = (this.t & 0x7f00) | val; this.v = this.t; this.w = 0; } break;
        case 0x2007: this.ppuWrite(this.v, val); this.v += (this.ctrl & 0x04) ? 32 : 1; this.v &= 0x7fff; break;
      }
      this.openBus = val;
    }
    doDMA(buf) { for (let i = 0; i < 256; i++) this.oam[(this.oamaddr + i) & 0xff] = buf[i]; }
    ntIndex(addr) {
      const a = (addr - 0x2000) & 0x0fff;
      const nt = (a >> 10) & 3;
      const off = a & 0x03ff;

      // Always use the current mirror value (updated dynamically by mapper)
      const mirror = this.mirror;

      if (mirror === "vertical") return ((nt & 1) * 0x400) + off;
      if (mirror === "horizontal") return (((nt >> 1) & 1) * 0x400) + off;
      if (mirror === "single0" || mirror === "singlescreen" || mirror === "single-screen-lower") return off;
      if (mirror === "single1" || mirror === "single-screen-upper") return 0x400 + off;
      if (mirror === "four" || mirror === "fourscreen") return a;
      return (((nt >> 1) & 1) * 0x400) + off;
    }
    ppuRead(addr) { addr &= 0x3fff; if (addr < 0x2000) return this.mapper.chrRead(addr); if (addr < 0x3f00) return this.vram[this.ntIndex(addr)]; let palAddr = addr & 0x1f; if ((palAddr & 3) === 0) palAddr &= 0x0F; return this.palette[palAddr]; }
    ppuWrite(addr, val) { addr &= 0x3fff; val &= 0xff; if (addr < 0x2000) { this.mapper.chrWrite(addr, val); return; } if (addr < 0x3f00) { this.vram[this.ntIndex(addr)] = val; return; } let palAddr = addr & 0x1f; if ((palAddr & 3) === 0) palAddr &= 0x0F; this.palette[palAddr] = val; }
    incCoarseX() { if ((this.v & 0x001f) === 31) { this.v &= ~0x001f; this.v ^= 0x0400; } else { this.v++; } }
    incY() { if ((this.v & 0x7000) !== 0x7000) { this.v += 0x1000; } else { this.v &= ~0x7000; let y = (this.v & 0x03e0) >> 5; if (y === 29) { y = 0; this.v ^= 0x0800; } else if (y === 31) { y = 0; } else { y++; } this.v = (this.v & ~0x03e0) | (y << 5); } }
    copyX() { this.v = (this.v & ~0x041f) | (this.t & 0x041f); }
    copyY() { this.v = (this.v & ~0x7be0) | (this.t & 0x7be0); }
    bgFetch() { const nt = 0x2000 | (this.v & 0x0fff); const at = 0x23c0 | (this.v & 0x0c00) | ((this.v >> 4) & 0x38) | ((this.v >> 2) & 0x07); const fineY = (this.v >> 12) & 7; const tile = this.ppuRead(nt); const attr = this.ppuRead(at); const coarseX = this.v & 0x1F; const coarseY = (this.v >> 5) & 0x1F; const shift = ((coarseY & 2) << 1) | (coarseX & 2); const pal = (attr >> shift) & 3; const base = (this.ctrl & 0x10) ? 0x1000 : 0x0000; const addr = base + tile * 16 + fineY; const lo = this.ppuRead(addr); const hi = this.ppuRead(addr + 8); return { lo, hi, pal }; }
    reloadShifters() { this.bgShiftLo = (this.bgShiftLo & 0xFF00) | this.bgLatch.lo; this.bgShiftHi = (this.bgShiftHi & 0xFF00) | this.bgLatch.hi; const attrLo = (this.bgLatch.pal & 1) ? 0xFF : 0x00; const attrHi = (this.bgLatch.pal & 2) ? 0xFF : 0x00; this.bgAttrShiftLo = (this.bgAttrShiftLo & 0xFF00) | attrLo; this.bgAttrShiftHi = (this.bgAttrShiftHi & 0xFF00) | attrHi; }
    evalSprites() { const y = this.scanline; this.spriteCount = 0; this.spriteZeroInLine = false; for (let i = 0; i < 32; i++) { this.secOAM[i] = 0xFF; } for (let i = 0; i < 64; i++) { const o = i * 4; const sy = this.oam[o]; if (sy >= 0xEF) continue; const tile = this.oam[o + 1]; const attr = this.oam[o + 2]; const sx = this.oam[o + 3]; const h = (this.ctrl & 0x20) ? 16 : 8; const row = y - sy; if (row >= 0 && row < h) { if (this.spriteCount < 8) { if (i === 0) this.spriteZeroInLine = true; this.secOAM[this.spriteCount * 4 + 0] = sy; this.secOAM[this.spriteCount * 4 + 1] = tile; this.secOAM[this.spriteCount * 4 + 2] = attr; this.secOAM[this.spriteCount * 4 + 3] = sx; this.spriteCount++; } else { this.status |= 0x20; } } } }
    renderPixel(x, y) {
      const idx = (y * 256 + x) * 4; const img = this.output.data; let bgPx = 0, bgPal = 0; let spriteOpaque = false, spritePriority = 0, spritePx = 0, spritePal = 0; let sprite0 = false;
      if (this.mask & 0x08) { const bitMux = 15 - this.fineXLatch; const p0 = (this.bgShiftLo >> bitMux) & 1; const p1 = (this.bgShiftHi >> bitMux) & 1; bgPx = (p1 << 1) | p0; const a0 = (this.bgAttrShiftLo >> bitMux) & 1; const a1 = (this.bgAttrShiftHi >> bitMux) & 1; bgPal = (a1 << 1) | a0; }
      if (this.mask & 0x10) { for (let i = 0; i < this.spriteCount; i++) { const o = i * 4; const sy = this.secOAM[o]; const tile = this.secOAM[o + 1]; const attr = this.secOAM[o + 2]; const sx = this.secOAM[o + 3]; if (x < sx || x >= sx + 8) continue; const h = (this.ctrl & 0x20) ? 16 : 8; const row = y - sy; if (row < 0 || row >= h) continue; if (i === 0 && this.spriteZeroInLine) sprite0 = true; const flipV = (attr >> 7) & 1; const flipH = (attr >> 6) & 1; spritePriority = (attr >> 5) & 1; const paletteIdx = (attr & 3); let fineY = flipV ? (h - 1 - row) : row; let tileNum = tile; let base = 0; if (h === 16) { base = (tile & 1) ? 0x1000 : 0x0000; tileNum = tile & 0xFE; if (fineY >= 8) { tileNum++; fineY -= 8; } } else { base = (this.ctrl & 0x08) ? 0x1000 : 0x0000; } const addr = base + tileNum * 16 + fineY; const lo = this.ppuRead(addr); const hi = this.ppuRead(addr + 8); const bit = flipH ? (x - sx) : (7 - (x - sx)); const p0 = (lo >> bit) & 1; const p1 = (hi >> bit) & 1; spritePx = (p1 << 1) | p0; if (spritePx !== 0) { spriteOpaque = true; spritePal = paletteIdx; break; } } }
      if (sprite0 && spriteOpaque && bgPx !== 0) { if (x < 255 && x >= 8) { const bgOn = (this.mask & 0x08) !== 0; const sprOn = (this.mask & 0x10) !== 0; if (bgOn && sprOn) this.status |= 0x40; } else if (x < 255) { const leftBgOn = (this.mask & 0x02) !== 0; const leftSprOn = (this.mask & 0x04) !== 0; if ((this.mask & 0x08) && (this.mask & 0x10) && leftBgOn && leftSprOn) { this.status |= 0x40; } } }
      let paletteIndex = 0; const bgOpaque = bgPx !== 0; const sprOpaque = spriteOpaque && spritePx !== 0;
      if (!bgOpaque && !sprOpaque) { paletteIndex = 0; } else if (bgOpaque && !sprOpaque) { paletteIndex = (bgPal << 2) | bgPx; } else if (!bgOpaque && sprOpaque) { paletteIndex = 0x10 | (spritePal << 2) | spritePx; } else { if (spritePriority === 0) { paletteIndex = 0x10 | (spritePal << 2) | spritePx; } else { paletteIndex = (bgPal << 2) | bgPx; } }
      if (x < 8) { if (!(this.mask & 0x02) && bgOpaque) { if (!sprOpaque) paletteIndex = 0; else if (spritePriority === 0) paletteIndex = 0x10 | (spritePal << 2) | spritePx; else paletteIndex = 0; } if (!(this.mask & 0x04) && sprOpaque) { if (!bgOpaque) paletteIndex = 0; else paletteIndex = (bgPal << 2) | bgPx; } if (!(this.mask & 0x02) && !(this.mask & 0x04)) paletteIndex = 0; }
      const color = this.ppuRead(0x3F00 + (paletteIndex & 0x1F)); const rgb = NTSC_PALETTE[color & 0x3F]; img[idx] = rgb[0]; img[idx + 1] = rgb[1]; img[idx + 2] = rgb[2]; img[idx + 3] = 255;
    }
    step() {
      if(this.mapper && this.mapper.ppuCycle) this.mapper.ppuCycle();
      const renderingEnabled = (this.mask & 0x18) !== 0;
      if (this.scanline === 261 && this.cycle === 339 && renderingEnabled && this.oddFrame) { this.cycle = 0; this.scanline = 0; this.frame++; this.oddFrame = false; return; }
      if (this.scanline === 261) {
        if (this.cycle === 0 && renderingEnabled) this.fineXLatch = this.x;
        if (this.cycle === 1) { this.status &= ~(0x80 | 0x40 | 0x20); this.nmi = false; }
        if (this.cycle === 257 && renderingEnabled) this.copyX();
        if (this.cycle >= 280 && this.cycle <= 304 && renderingEnabled) this.copyY();
        if (this.cycle >= 321 && this.cycle <= 336 && renderingEnabled) { this.bgShiftLo <<= 1; this.bgShiftHi <<= 1; this.bgAttrShiftLo <<= 1; this.bgAttrShiftHi <<= 1; const cycleInTile = (this.cycle - 1) % 8; if (cycleInTile === 1) this.bgLatch = this.bgFetch(); if (cycleInTile === 0 && this.cycle > 321) this.reloadShifters(); if (cycleInTile === 7) this.incCoarseX(); }
      }
      if (this.scanline >= 0 && this.scanline < 240) {
        if (this.cycle === 0 && renderingEnabled) this.fineXLatch = this.x;
        if (this.cycle === 1 && renderingEnabled) this.evalSprites();
        if (this.cycle >= 1 && this.cycle <= 256) {
          if (renderingEnabled) { this.bgShiftLo <<= 1; this.bgShiftHi <<= 1; this.bgAttrShiftLo <<= 1; this.bgAttrShiftHi <<= 1; }
          const cycleInTile = (this.cycle - 1) % 8; if (cycleInTile === 0 && renderingEnabled) this.reloadShifters(); if (cycleInTile === 1 && renderingEnabled) this.bgLatch = this.bgFetch();
          this.renderPixel(this.cycle - 1, this.scanline); if (cycleInTile === 7 && renderingEnabled) this.incCoarseX();
        }
        if (this.cycle === 256 && renderingEnabled) this.incY(); if (this.cycle === 257 && renderingEnabled) this.copyX();
        if (this.cycle >= 321 && this.cycle <= 336 && renderingEnabled) { this.bgShiftLo <<= 1; this.bgShiftHi <<= 1; this.bgAttrShiftLo <<= 1; this.bgAttrShiftHi <<= 1; const cycleInTile = (this.cycle - 1) % 8; if (cycleInTile === 0 && this.cycle > 321) this.reloadShifters(); if (cycleInTile === 1) this.bgLatch = this.bgFetch(); if (cycleInTile === 7) this.incCoarseX(); }
      }
      if (this.scanline === 241 && this.cycle === 1) { this.status |= 0x80; if (this.ctrl & 0x80) { this.nmi = true; } this.ctx.putImageData(this.output, 0, 0); this.frameComplete = true; }
      this.cycle++; if (this.cycle > 340) { this.cycle = 0; this.scanline++; if (this.scanline > 261) { this.scanline = 0; this.frame++; this.oddFrame = !this.oddFrame; } }
    }
  }
  const NTSC_PALETTE = [
    [102,102,102], [0,42,136], [20,18,167], [59,0,164], [92,0,126], [110,0,64], [108,6,0], [88,20,0], [62,39,0], [15,58,0], [0,65,0], [0,60,0], [0,50,60], [0,0,0], [0,0,0], [0,0,0],
    [173,173,173], [21,95,217], [66,64,255], [117,39,254], [160,26,204], [183,30,123], [181,49,32], [156,66,0], [121,87,0], [65,110,0], [21,121,0], [0,117,38], [0,105,130], [0,0,0], [0,0,0], [0,0,0],
    [255,255,255], [102,176,255], [146,144,255], [198,118,255], [243,106,255], [254,110,204], [254,129,112], [234,148,0], [200,168,0], [144,192,0], [99,203,0], [75,198,89], [77,188,180], [79,79,79], [0,0,0], [0,0,0],
    [255,255,255], [192,223,255], [211,210,255], [232,200,255], [251,194,255], [254,196,234], [254,204,197], [247,212,148], [232,221,148], [210,230,148], [192,235,148], [182,233,184], [183,229,222], [184,184,184], [0,0,0], [0,0,0]
];

// ===== CPU =====
class CPU6502{
    constructor(bus){ this.bus=bus; this.a=0; this.x=0; this.y=0; this.sp=0xFD; this.p=0x24; this.pc=0; this.cycles=0; this.stall=0; this.resetVector=0x8000; this.irqLine=false; this.prevIrqLine = false; }
    getC(){return this.p&1;} setC(v){this.p = (this.p & ~1) | (v&1);} getZ(){return (this.p>>1)&1;} setZ(v){this.p = (this.p & ~2) | ((v?1:0)<<1);} getI(){return (this.p>>2)&1;} setI(v){this.p = (this.p & ~4) | ((v?1:0)<<2);} getD(){return (this.p>>3)&1;} setD(v){this.p = (this.p & ~8) | ((v?1:0)<<3);} getB(){return (this.p>>4)&1;} setB(v){this.p = (this.p & ~16)|((v?1:0)<<4);} getU(){return (this.p>>5)&1;} setU(v){this.p = (this.p & ~32)|((v?1:0)<<5);} getV(){return (this.p>>6)&1;} setV(v){this.p = (this.p & ~64)|((v?1:0)<<6);} getN(){return (this.p>>7)&1;} setN(v){this.p = (this.p & ~128)|((v?1:0)<<7);}
    read(a){return this.bus.cpuRead(a);} write(a,v){this.bus.cpuWrite(a,v);}
    push(v){this.write(0x100+this.sp, v); this.sp=u8(this.sp-1);} pop(){this.sp=u8(this.sp+1); return this.read(0x100+this.sp);}
    reset(){ this.a=0; this.x=0; this.y=0; this.sp=0xFD; this.p=0x24; const lo=this.read(0xFFFC), hi=this.read(0xFFFD); this.pc=lo | (hi<<8); this.cycles=7; this.stall=0; }

    // ===== FIXED NMI: Push status BEFORE modifying I flag =====
    nmi(){
      this.push((this.pc>>8)&0xFF);
      this.push(this.pc&0xFF);
      const statusToPush = (this.p & 0xEF) | 0x20;
      this.push(statusToPush);
      this.setI(1);
      const lo=this.read(0xFFFA), hi=this.read(0xFFFB);
      this.pc=lo|(hi<<8);
      this.cycles+=7;
    }

    // ===== FIXED IRQ: Level-triggered, correct flag order =====
    irq(){
      // IRQ only fires when I flag is CLEAR (interrupts enabled)
      if(this.getI()) return;

      this.push((this.pc>>8)&0xFF);
      this.push(this.pc&0xFF);

      const statusToPush = (this.p & 0xEF) | 0x20;
      this.push(statusToPush);

      this.setI(1);

      // Read IRQ vector
      const lo=this.read(0xFFFE), hi=this.read(0xFFFF);
      this.pc=lo|(hi<<8);
      this.cycles+=7;

    }

    step(){

      if(this.stall>0){ this.stall--; this.cycles++; return 1; }


if (this.irqLine && !this.prevIrqLine && !this.getI()) {
    this.irq();
}

this.prevIrqLine = this.irqLine;

      const op=this.read(this.pc++); const e = OPCODES[op]; if(!e){ return 2; }
      const {mode, ins, cyc} = e; this.addrMode=mode; this.pageCross=0; const addr = this.fetchAddr(mode);
      const cyclesBefore=this.cycles; this.execute(ins, addr); let c = cyc + this.pageCross; this.cycles += c; return this.cycles - cyclesBefore;
    }

    fetchAddr(mode){
      const zp=()=>this.read(this.pc++); const zpX=()=>u8(zp()+this.x); const zpY=()=>u8(zp()+this.y); const imm=()=>this.pc++;
      const abs=()=>{const lo=this.read(this.pc++), hi=this.read(this.pc++); return lo|(hi<<8)};
      const absX=()=>{const a=abs(); const res=u16(a+this.x); if((a^res)&0xFF00) this.pageCross=1; return res;}
      const absY=()=>{const a=abs(); const res=u16(a+this.y); if((a^res)&0xFF00) this.pageCross=1; return res;}
      const indX=()=>{const t = u8(this.read(this.pc++) + this.x); const lo=this.read(t), hi=this.read(u8(t+1)); return lo|(hi<<8)};
      const indY=()=>{const t = this.read(this.pc++); const lo=this.read(t), hi=this.read(u8(t+1)); const a=lo|(hi<<8); const res=u16(a+this.y); if((a^res)&0xFF00) this.pageCross=1; return res;}
      switch(mode){
        case 'IMP': return null; case 'IMM': return imm(); case 'ZP0': return zp(); case 'ZPX': return zpX(); case 'ZPY': return zpY();
        case 'ABS': return abs(); case 'ABX': return absX(); case 'ABY': return absY(); case 'IZX': return indX(); case 'IZY': return indY();
        case 'IND': {const ptr=abs(); const lo=this.read(ptr); const hi=this.read((ptr&0xFF00)|((ptr+1)&0xFF)); return lo|(hi<<8);}
        case 'REL': {const off=u8(this.read(this.pc++)); return off<0x80? this.pc+off : this.pc+off-0x100;}
      }
    }
    setZN(v){ this.setZ((v&0xFF)===0); this.setN(v&0x80); }
    execute(ins, addr){
      const rd = a=>this.read(a); const wr=(a,v)=>this.write(a,u8(v));
      const ADC=v=>{const t=this.a+v+this.getC(); this.setC(t>0xFF); this.setV((~(this.a^v) & (this.a^t) & 0x80)); this.a=u8(t); this.setZN(this.a);}
      const SBC=v=>{ADC(v^0xFF)}; const CMP=(r,v)=>{const t=r-v; this.setC(r>=v); this.setZN(u8(t));}
      const BIT=v=>{this.setZ((this.a & v)===0); this.setV(v&0x40); this.setN(v&0x80);}
      switch(ins){
        case 'BRK': this.pc++; this.push((this.pc>>8)&0xFF); this.push(this.pc&0xFF); this.setB(1); this.push(this.p); this.setI(1); this.pc = this.read(0xFFFE) | (this.read(0xFFFF)<<8); break;
        case 'NOP': break; case 'LDA': this.a=rd(addr); this.setZN(this.a); break;
        case 'LDX': this.x=rd(addr); this.setZN(this.x); break; case 'LDY': this.y=rd(addr); this.setZN(this.y); break;
        case 'STA': wr(addr,this.a); break; case 'STX': wr(addr,this.x); break; case 'STY': wr(addr,this.y); break;
        case 'TAX': this.x=this.a; this.setZN(this.x); break; case 'TAY': this.y=this.a; this.setZN(this.y); break;
        case 'TXA': this.a=this.x; this.setZN(this.a); break; case 'TYA': this.a=this.y; this.setZN(this.a); break;
        case 'TSX': this.x=this.sp; this.setZN(this.x); break; case 'TXS': this.sp=this.x; break;
        case 'PHA': this.push(this.a); break; case 'PHP': this.push(this.p|0x10); break;
        case 'PLA': this.a=this.pop(); this.setZN(this.a); break; case 'PLP': this.p=(this.pop()&0xEF)|0x20; break;
        case 'AND': this.a &= rd(addr); this.setZN(this.a); break; case 'ORA': this.a |= rd(addr); this.setZN(this.a); break;
        case 'EOR': this.a ^= rd(addr); this.setZN(this.a); break;
        case 'ADC': ADC(rd(addr)); break; case 'SBC': SBC(rd(addr)); break;
        case 'CMP': CMP(this.a, rd(addr)); break; case 'CPX': CMP(this.x, rd(addr)); break; case 'CPY': CMP(this.y, rd(addr)); break;
        case 'INC': {const v=u8(rd(addr)+1); wr(addr,v); this.setZN(v); } break; case 'INX': this.x=u8(this.x+1); this.setZN(this.x); break; case 'INY': this.y=u8(this.y+1); this.setZN(this.y); break;
        case 'DEC': {const v=u8(rd(addr)-1); wr(addr,v); this.setZN(v); } break; case 'DEX': this.x=u8(this.x-1); this.setZN(this.x); break; case 'DEY': this.y=u8(this.y-1); this.setZN(this.y); break;
        case 'ASL': if(this.addrMode==='IMP'){ this.setC(this.a>>7); this.a=u8(this.a<<1); this.setZN(this.a);} else { const v=rd(addr); this.setC(v>>7); const r=u8(v<<1); wr(addr,r); this.setZN(r);} break;
        case 'LSR': if(this.addrMode==='IMP'){ this.setC(this.a&1); this.a=u8(this.a>>>1); this.setZN(this.a);} else { const v=rd(addr); this.setC(v&1); const r=u8(v>>>1); wr(addr,r); this.setZN(r);} break;
        case 'ROL': if(this.addrMode==='IMP'){ const c=this.getC(); this.setC(this.a>>7); this.a=u8((this.a<<1)|c); this.setZN(this.a);} else { const v=rd(addr); const c=this.getC(); this.setC(v>>7); const r=u8((v<<1)|c); wr(addr,r); this.setZN(r);} break;
        case 'ROR': if(this.addrMode==='IMP'){ const c=this.getC(); this.setC(this.a&1); this.a=u8((this.a>>>1)|(c<<7)); this.setZN(this.a);} else { const v=rd(addr); const c=this.getC(); this.setC(v&1); const r=u8((v>>>1)|(c<<7)); wr(addr,r); this.setZN(r);} break;
        case 'BIT': BIT(rd(addr)); break; case 'JMP': this.pc = addr; break;
        case 'JSR': {const t=u16(this.pc-1); this.push((t>>8)&0xFF); this.push(t&0xFF); this.pc=addr;} break;
        case 'RTS': {const lo=this.pop(), hi=this.pop(); this.pc = ((hi<<8)|lo) + 1;} break;
        case 'RTI': {this.p=(this.pop()&0xEF)|0x20; const lo=this.pop(), hi=this.pop(); this.pc=(hi<<8)|lo;} break;
        case 'BCC': {const cond=!this.getC(); if(cond){ this.cycles++; if((this.pc&0xFF00)!=(addr&0xFF00)) this.cycles++; this.pc=addr; }} break;
        case 'BCS': {const cond=this.getC(); if(cond){ this.cycles++; if((this.pc&0xFF00)!=(addr&0xFF00)) this.cycles++; this.pc=addr; }} break;
        case 'BEQ': {const cond=this.getZ(); if(cond){ this.cycles++; if((this.pc&0xFF00)!=(addr&0xFF00)) this.cycles++; this.pc=addr; }} break;
        case 'BMI': {const cond=this.getN(); if(cond){ this.cycles++; if((this.pc&0xFF00)!=(addr&0xFF00)) this.cycles++; this.pc=addr; }} break;
        case 'BNE': {const cond=!this.getZ(); if(cond){ this.cycles++; if((this.pc&0xFF00)!=(addr&0xFF00)) this.cycles++; this.pc=addr; }} break;
        case 'BPL': {const cond=!this.getN(); if(cond){ this.cycles++; if((this.pc&0xFF00)!=(addr&0xFF00)) this.cycles++; this.pc=addr; }} break;
        case 'BVC': {const cond=!this.getV(); if(cond){ this.cycles++; if((this.pc&0xFF00)!=(addr&0xFF00)) this.cycles++; this.pc=addr; }} break;
        case 'BVS': {const cond=this.getV(); if(cond){ this.cycles++; if((this.pc&0xFF00)!=(addr&0xFF00)) this.cycles++; this.pc=addr; }} break;
        case 'CLC': this.setC(0); break; case 'SEC': this.setC(1); break; case 'CLI': this.setI(0); break; case 'SEI': this.setI(1); break; case 'CLV': this.setV(0); break; case 'CLD': this.setD(0); break; case 'SED': this.setD(1); break;
      }
    }
  }

  // ===== Helper Functions =====
  const O = (mode, ins, cyc) => ({mode, ins, cyc});
  const OPCODES = new Array(256);
  const fill = (list)=>list.forEach(([op,mode,ins,cyc])=>OPCODES[op]=O(mode,ins,cyc));
  fill([
    [0x00,'IMP','BRK',7],[0xEA,'IMP','NOP',2],
    [0xA9,'IMM','LDA',2],[0xA5,'ZP0','LDA',3],[0xB5,'ZPX','LDA',4],[0xAD,'ABS','LDA',4],[0xBD,'ABX','LDA',4],[0xB9,'ABY','LDA',4],[0xA1,'IZX','LDA',6],[0xB1,'IZY','LDA',5],
    [0xA2,'IMM','LDX',2],[0xA6,'ZP0','LDX',3],[0xB6,'ZPY','LDX',4],[0xAE,'ABS','LDX',4],[0xBE,'ABY','LDX',4],
    [0xA0,'IMM','LDY',2],[0xA4,'ZP0','LDY',3],[0xB4,'ZPX','LDY',4],[0xAC,'ABS','LDY',4],[0xBC,'ABX','LDY',4],
    [0x85,'ZP0','STA',3],[0x95,'ZPX','STA',4],[0x8D,'ABS','STA',4],[0x9D,'ABX','STA',5],[0x99,'ABY','STA',5],[0x81,'IZX','STA',6],[0x91,'IZY','STA',6],
    [0x86,'ZP0','STX',3],[0x96,'ZPY','STX',4],[0x8E,'ABS','STX',4],
    [0x84,'ZP0','STY',3],[0x94,'ZPX','STY',4],[0x8C,'ABS','STY',4],
    [0xAA,'IMP','TAX',2],[0xA8,'IMP','TAY',2],[0x8A,'IMP','TXA',2],[0x98,'IMP','TYA',2],
    [0xBA,'IMP','TSX',2],[0x9A,'IMP','TXS',2],
    [0x48,'IMP','PHA',3],[0x08,'IMP','PHP',3],[0x68,'IMP','PLA',4],[0x28,'IMP','PLP',4],
    [0x29,'IMM','AND',2],[0x25,'ZP0','AND',3],[0x35,'ZPX','AND',4],[0x2D,'ABS','AND',4],[0x3D,'ABX','AND',4],[0x39,'ABY','AND',4],[0x21,'IZX','AND',6],[0x31,'IZY','AND',5],
    [0x09,'IMM','ORA',2],[0x05,'ZP0','ORA',3],[0x15,'ZPX','ORA',4],[0x0D,'ABS','ORA',4],[0x1D,'ABX','ORA',4],[0x19,'ABY','ORA',4],[0x01,'IZX','ORA',6],[0x11,'IZY','ORA',5],
    [0x49,'IMM','EOR',2],[0x45,'ZP0','EOR',3],[0x55,'ZPX','EOR',4],[0x4D,'ABS','EOR',4],[0x5D,'ABX','EOR',4],[0x59,'ABY','EOR',4],[0x41,'IZX','EOR',6],[0x51,'IZY','EOR',5],
    [0x69,'IMM','ADC',2],[0x65,'ZP0','ADC',3],[0x75,'ZPX','ADC',4],[0x6D,'ABS','ADC',4],[0x7D,'ABX','ADC',4],[0x79,'ABY','ADC',4],[0x61,'IZX','ADC',6],[0x71,'IZY','ADC',5],
    [0xE9,'IMM','SBC',2],[0xE5,'ZP0','SBC',3],[0xF5,'ZPX','SBC',4],[0xED,'ABS','SBC',4],[0xFD,'ABX','SBC',4],[0xF9,'ABY','SBC',4],[0xE1,'IZX','SBC',6],[0xF1,'IZY','SBC',5],
    [0xC9,'IMM','CMP',2],[0xC5,'ZP0','CMP',3],[0xD5,'ZPX','CMP',4],[0xCD,'ABS','CMP',4],[0xDD,'ABX','CMP',4],[0xD9,'ABY','CMP',4],[0xC1,'IZX','CMP',6],[0xD1,'IZY','CMP',5],
    [0xE0,'IMM','CPX',2],[0xE4,'ZP0','CPX',3],[0xEC,'ABS','CPX',4],
    [0xC0,'IMM','CPY',2],[0xC4,'ZP0','CPY',3],[0xCC,'ABS','CPY',4],
    [0xE6,'ZP0','INC',5],[0xF6,'ZPX','INC',6],[0xEE,'ABS','INC',6],[0xFE,'ABX','INC',7],
    [0xC6,'ZP0','DEC',5],[0xD6,'ZPX','DEC',6],[0xCE,'ABS','DEC',6],[0xDE,'ABX','DEC',7],
    [0xE8,'IMP','INX',2],[0xC8,'IMP','INY',2],[0xCA,'IMP','DEX',2],[0x88,'IMP','DEY',2],
    [0x0A,'IMP','ASL',2],[0x06,'ZP0','ASL',5],[0x16,'ZPX','ASL',6],[0x0E,'ABS','ASL',6],[0x1E,'ABX','ASL',7],
    [0x4A,'IMP','LSR',2],[0x46,'ZP0','LSR',5],[0x56,'ZPX','LSR',6],[0x4E,'ABS','LSR',6],[0x5E,'ABX','LSR',7],
    [0x2A,'IMP','ROL',2],[0x26,'ZP0','ROL',5],[0x36,'ZPX','ROL',6],[0x2E,'ABS','ROL',6],[0x3E,'ABX','ROL',7],
    [0x6A,'IMP','ROR',2],[0x66,'ZP0','ROR',5],[0x76,'ZPX','ROR',6],[0x6E,'ABS','ROR',6],[0x7E,'ABX','ROR',7],
    [0x24,'ZP0','BIT',3],[0x2C,'ABS','BIT',4],
    [0x4C,'ABS','JMP',3],[0x6C,'IND','JMP',5],
    [0x20,'ABS','JSR',6],[0x60,'IMP','RTS',6],[0x40,'IMP','RTI',6],
    [0x90,'REL','BCC',2],[0xB0,'REL','BCS',2],[0xF0,'REL','BEQ',2],[0x30,'REL','BMI',2],[0xD0,'REL','BNE',2],[0x10,'REL','BPL',2],[0x50,'REL','BVC',2],[0x70,'REL','BVS',2],
    [0x18,'IMP','CLC',2],[0x38,'IMP','SEC',2],[0x58,'IMP','CLI',2],[0x78,'IMP','SEI',2],[0xB8,'IMP','CLV',2],[0xD8,'IMP','CLD',2],[0xF8,'IMP','SED',2],
  ]);

  // ===== NES Machine =====
  class NES {
    constructor(canvas) {
      this.ppu = new PPU();
      this.ppu.attachCanvas(canvas);
      this.input = new Controllers();
      this.cart = null; this.bus = null; this.cpu = null; this.apu = new APU();
      this.running = false; this.makeResponsiveCanvas();
      this._lastFrameTime = 0; this._frameInterval = 1000/60; this._pendingFrames = 0; this._lastFpsUpdate = performance.now(); this._frameCount = 0; this._cpuCycleDebt = 0; this._lastTimestamp = 0;
    }
    makeResponsiveCanvas() {
      const c = this.ppu.canvas;
      const resize = () => { if(window.innerWidth < 900) { c.style.width = "98vw"; c.style.height = Math.round(240*98/256) + "vw"; } else { c.style.width = "768px"; c.style.height = "720px"; } };
      window.addEventListener('resize', resize); resize();
    }
    loadROM(bytes) {
      this.cart = new Cartridge(bytes); this.ppu.connectCart(this.cart);
      this.bus = new Bus(null, this.ppu, this.cart, this.input, this.apu);
      this.cpu = new CPU6502(this.bus); this.bus.cpu = this.cpu;
      if (this.ppu.mapper instanceof Mapper4) { this.ppu.mapper.cpu = this.cpu; this.ppu.mapper.ppu = this.ppu; }
      this.cpu.reset();
      const elMap = document.getElementById('mapper'); const elMir = document.getElementById('mirror');
      if(elMap) elMap.textContent = this.cart.mapper; if(elMir) elMir.textContent = this.cart.mirror;
    }
    reset() { if (!this.cpu) return; this.cpu.reset(); this.ppu.reset(); }
    step() { const cyc = this.cpu.step(); for (let i = 0; i < cyc * 3; i++) { this.ppu.step(); if (this.ppu.nmi) { this.cpu.nmi(); this.ppu.nmi = false; } } this.apu.step(cyc); }
    run() {
      if (this.running) return;
      this.running = true; this._lastTimestamp = performance.now(); this._cpuCycleDebt = 0;
      const animate = (now) => {
        if (!this.running) return;
        const elapsed = now - this._lastTimestamp; this._lastTimestamp = now;
        if (elapsed > 100) { requestAnimationFrame(animate); return; }
        const cyclesThisFrame = (elapsed * (CPU_FREQ / 1000) * Settings.emulation.speed) + this._cpuCycleDebt;
        const cyclesToRun = Math.floor(cyclesThisFrame); this._cpuCycleDebt = cyclesThisFrame - cyclesToRun;
        let cpuCyclesExecuted = 0;
        while (cpuCyclesExecuted < cyclesToRun) {
          const cyc = this.cpu.step(); cpuCyclesExecuted += cyc;
          for (let i = 0; i < cyc * 3; i++) { this.ppu.step(); if (this.ppu.nmi) { this.cpu.nmi(); this.ppu.nmi = false; } }
          this.apu.step(cyc);
        }
        if (this.ppu.frameComplete) { this._frameCount++; this.ppu.frameComplete = false; this.apu.debugFrameCount++; }
        if (now - this._lastFpsUpdate >= 1000) {
          const elFps = document.getElementById('fps'); const elMhz = document.getElementById('mhz'); const elIrqs = document.getElementById('irqs');
          if (elFps) elFps.textContent = this._frameCount; if (elMhz) elMhz.textContent = "~1.79";
          if (elIrqs && this.ppu.mapper instanceof Mapper4) { elIrqs.textContent = `Cnt:${this.ppu.mapper.irqCounter} En:${this.ppu.mapper.irqEnable?'Y':'N'}`; } else if (elIrqs) { elIrqs.textContent = '—'; }
          this._frameCount = 0; this._lastFpsUpdate = now;
        }
        requestAnimationFrame(animate);
      };
      requestAnimationFrame(animate);
    }
    pause() { this.running = false; }
    serializeState() {
      if (!this.cpu || !this.ppu || !this.cart) { throw new Error('No ROM loaded'); }
      const m = this.cart.mapperObj;
      let mapper;
      switch (this.cart.mapper) {
        case 0:
          mapper = { type: 0 };
          break;
        case 1:
          // Field names match the actual Mapper1 properties: shift, ctrl, prgRAM
          mapper = {
            type: 1,
            shift: m.shift, ctrl: m.ctrl, prgBank: m.prgBank,
            chrBank0: m.chrBank0, chrBank1: m.chrBank1,
            prgRAM: Array.from(m.prgRAM)
          };
          break;
        case 2:
          // Mapper2 field is 'bank', not 'prgBank'
          mapper = { type: 2, bank: m.bank };
          break;
        case 3:
          mapper = { type: 3, chrBank: m.chrBank };
          break;
        case 4:
          mapper = {
            type: 4,
            bankSelect: m.bankSelect, bankData: Array.from(m.bankData),
            prgMode: m.prgMode, chrMode: m.chrMode,
            irqLatch: m.irqLatch, irqCounter: m.irqCounter,
            irqEnable: m.irqEnable, irqReloadPending: m.irqReloadPending,
            prgBanks: Array.from(m.prgBanks), chrBanks: Array.from(m.chrBanks)
          };
          break;
        case 9:
          // Mapper9 (MMC2) — latch state is critical for correct CHR banking
          mapper = {
            type: 9,
            prgBankSelect: m.prgBankSelect,
            chrBanks: Array.from(m.chrBanks),
            latch0: m.latch0, latch1: m.latch1
          };
          break;
        default:
          mapper = { type: this.cart.mapper };
      }
      return {
        version: 2,
        // ── CPU ── use the actual lowercase field names (a, x, y, sp, pc, p)
        cpu: {
          a: this.cpu.a, x: this.cpu.x, y: this.cpu.y,
          sp: this.cpu.sp, pc: this.cpu.pc, p: this.cpu.p,
          cycles: this.cpu.cycles,
          stall: this.cpu.stall,
          irqLine: this.cpu.irqLine,
          prevIrqLine: this.cpu.prevIrqLine
        },
        // ── PPU ── include all shift registers, latches and rendering state
        ppu: {
          ctrl: this.ppu.ctrl, mask: this.ppu.mask, status: this.ppu.status,
          oamaddr: this.ppu.oamaddr,            // lowercase 'd' matches PPU field
          v: this.ppu.v, t: this.ppu.t, x: this.ppu.x, w: this.ppu.w,
          cycle: this.ppu.cycle, scanline: this.ppu.scanline,
          oddFrame: this.ppu.oddFrame, frame: this.ppu.frame,
          buffered: this.ppu.buffered, openBus: this.ppu.openBus,
          bgShiftLo: this.ppu.bgShiftLo, bgShiftHi: this.ppu.bgShiftHi,
          bgAttrShiftLo: this.ppu.bgAttrShiftLo, bgAttrShiftHi: this.ppu.bgAttrShiftHi,
          bgLatch: Object.assign({}, this.ppu.bgLatch),
          fineXLatch: this.ppu.fineXLatch,
          vram: Array.from(this.ppu.vram),
          oam: Array.from(this.ppu.oam),
          palette: Array.from(this.ppu.palette),
          mirror: this.ppu.mirror            // dynamic mirror mode (MMC1/MMC3 can change this)
        },
        // ── APU ── include frame sequencer timing fields
        apu: {
          frameCounter: this.apu.frameCounter, frameMode: this.apu.frameMode,
          irqInhibit: this.apu.irqInhibit, frameIRQ: this.apu.frameIRQ,
          totalCycles: this.apu.totalCycles,
          cpuCycleAccumulator: this.apu.cpuCycleAccumulator,
          frameSequencerCycle: this.apu.frameSequencerCycle,
          pulse1: Object.assign({}, this.apu.pulse1),
          pulse2: Object.assign({}, this.apu.pulse2),
          triangle: Object.assign({}, this.apu.triangle),
          noise: Object.assign({}, this.apu.noise),
          dmc: Object.assign({}, this.apu.dmc)
        },
        bus: { ram: Array.from(this.bus.ram) },
        // cart.sram is the 8KB battery-backed SRAM used by many games
        cart: { sram: Array.from(this.cart.sram), mirror: this.cart.mirror },
        mapper
      };
    }

    deserializeState(state) {
      if (!this.cpu || !this.ppu || !this.cart) { throw new Error('No ROM loaded'); }
      if (state.version !== 2) { throw new Error('Incompatible save state version (expected 2, got ' + state.version + '). Please re-save your state.'); }

      // Pause the emulator loop before touching any live state.
      // The caller (LemonNES.deserializeState) is responsible for calling run()
      // after this returns.
      const wasRunning = this.running;
      this.running = false;

      // ── CPU ── lowercase field names
      this.cpu.a = state.cpu.a;
      this.cpu.x = state.cpu.x;
      this.cpu.y = state.cpu.y;
      this.cpu.sp = state.cpu.sp;
      this.cpu.pc = state.cpu.pc;
      this.cpu.p = state.cpu.p;
      this.cpu.cycles = state.cpu.cycles;
      this.cpu.stall = state.cpu.stall || 0;
      this.cpu.irqLine = !!state.cpu.irqLine;
      this.cpu.prevIrqLine = !!state.cpu.prevIrqLine;

      // ── PPU ──
      this.ppu.ctrl = state.ppu.ctrl;
      this.ppu.mask = state.ppu.mask;
      this.ppu.status = state.ppu.status;
      this.ppu.oamaddr = state.ppu.oamaddr;   // lowercase 'd'
      this.ppu.v = state.ppu.v;
      this.ppu.t = state.ppu.t;
      this.ppu.x = state.ppu.x;
      this.ppu.w = state.ppu.w;
      this.ppu.cycle = state.ppu.cycle;
      this.ppu.scanline = state.ppu.scanline;
      this.ppu.oddFrame = !!state.ppu.oddFrame;
      this.ppu.frame = state.ppu.frame || 0;
      this.ppu.buffered = state.ppu.buffered || 0;
      this.ppu.openBus = state.ppu.openBus || 0;
      this.ppu.bgShiftLo = state.ppu.bgShiftLo || 0;
      this.ppu.bgShiftHi = state.ppu.bgShiftHi || 0;
      this.ppu.bgAttrShiftLo = state.ppu.bgAttrShiftLo || 0;
      this.ppu.bgAttrShiftHi = state.ppu.bgAttrShiftHi || 0;
      if (state.ppu.bgLatch) Object.assign(this.ppu.bgLatch, state.ppu.bgLatch);
      this.ppu.fineXLatch = state.ppu.fineXLatch || 0;
      this.ppu.vram.set(state.ppu.vram);
      this.ppu.oam.set(state.ppu.oam);
      this.ppu.palette.set(state.ppu.palette);
      // Restore dynamic mirror mode — must be set on both ppu and cart
      if (state.ppu.mirror) {
        this.ppu.mirror = state.ppu.mirror;
        this.cart.mirror = state.ppu.mirror;
      }

      // ── APU ──
      this.apu.frameCounter = state.apu.frameCounter;
      this.apu.frameMode = state.apu.frameMode;
      this.apu.irqInhibit = !!state.apu.irqInhibit;
      this.apu.frameIRQ = !!state.apu.frameIRQ;
      this.apu.totalCycles = state.apu.totalCycles || 0;
      this.apu.cpuCycleAccumulator = state.apu.cpuCycleAccumulator || 0;
      this.apu.frameSequencerCycle = state.apu.frameSequencerCycle || 0;
      Object.assign(this.apu.pulse1, state.apu.pulse1);
      Object.assign(this.apu.pulse2, state.apu.pulse2);
      Object.assign(this.apu.triangle, state.apu.triangle);
      Object.assign(this.apu.noise, state.apu.noise);
      Object.assign(this.apu.dmc, state.apu.dmc);
      // Drain stale audio samples so the restored APU starts fresh
      this.apu.audioBuffer = [];

      // ── Bus RAM ──
      this.bus.ram.set(state.bus.ram);

      // ── Cart SRAM ──
      if (state.cart && state.cart.sram) this.cart.sram.set(state.cart.sram);
      if (state.cart && state.cart.mirror) this.cart.mirror = state.cart.mirror;

      // ── Mapper ──
      const m = this.cart.mapperObj;
      switch (state.mapper.type) {
        case 0:
          break;
        case 1:
          if (!(m instanceof Mapper1)) throw new Error('Mapper mismatch: state has Mapper1 but cart uses Mapper' + this.cart.mapper);
          // Restore correct field names: shift, ctrl (NOT shiftReg / control)
          m.shift = state.mapper.shift;
          m.ctrl = state.mapper.ctrl;
          m.prgBank = state.mapper.prgBank;
          m.chrBank0 = state.mapper.chrBank0;
          m.chrBank1 = state.mapper.chrBank1;
          if (state.mapper.prgRAM) m.prgRAM.set(state.mapper.prgRAM);
          // Propagate the restored mirror to ppu
          if (m.ppu) m.ppu.mirror = this.cart.mirror;
          break;
        case 2:
          if (!(m instanceof Mapper2)) throw new Error('Mapper mismatch: state has Mapper2 but cart uses Mapper' + this.cart.mapper);
          // Field is 'bank', not 'prgBank'
          m.bank = state.mapper.bank;
          break;
        case 3:
          if (!(m instanceof Mapper3)) throw new Error('Mapper mismatch: state has Mapper3 but cart uses Mapper' + this.cart.mapper);
          m.chrBank = state.mapper.chrBank;
          break;
        case 4:
          if (!(m instanceof Mapper4)) throw new Error('Mapper mismatch: state has Mapper4 but cart uses Mapper' + this.cart.mapper);
          m.bankSelect = state.mapper.bankSelect;
          m.bankData.set(state.mapper.bankData);
          m.prgMode = state.mapper.prgMode;
          m.chrMode = state.mapper.chrMode;
          m.irqLatch = state.mapper.irqLatch;
          m.irqCounter = state.mapper.irqCounter;
          m.irqEnable = state.mapper.irqEnable;
          m.irqReloadPending = state.mapper.irqReloadPending;
          m.prgBanks.set(state.mapper.prgBanks);
          m.chrBanks.set(state.mapper.chrBanks);
          // Re-wire live CPU/PPU references (they don't change, but be explicit)
          m.cpu = this.cpu;
          m.ppu = this.ppu;
          break;
        case 9:
          if (!(m instanceof Mapper9)) throw new Error('Mapper mismatch: state has Mapper9 but cart uses Mapper' + this.cart.mapper);
          m.prgBankSelect = state.mapper.prgBankSelect;
          m.chrBanks.set(state.mapper.chrBanks);
          m.latch0 = state.mapper.latch0;
          m.latch1 = state.mapper.latch1;
          break;
        default:
          // Unknown mapper — log and continue; nothing to restore
          console.warn('deserializeState: no restore logic for mapper', state.mapper.type);
      }
    }
  }


  // ── Internal NES instance ─────────────────────────────────────────────────
  let _nes = null;
  let _canvas = null;
  let _fpsInterval = null;
  let _frameCount = 0;
  let _lastFpsTime = 0;

  function _init() {
    _canvas = document.getElementById('nes-canvas');
    if (!_canvas) { console.error('LemonNES: canvas #nes-canvas not found'); return; }
    _nes = new NES(_canvas);

    // FPS reporting to Android bridge
    _lastFpsTime = performance.now();
    setInterval(() => {
      const now = performance.now();
      const elapsed = now - _lastFpsTime;
      if (elapsed >= 1000) {
        const fps = Math.round((_frameCount / elapsed) * 1000);
        _frameCount = 0;
        _lastFpsTime = now;
        if (global.LemonBridge && global.LemonBridge.onFpsUpdate) {
          global.LemonBridge.onFpsUpdate(fps);
        }
      }
    }, 1000);

    // Patch NES.run() to count frames for us
    const _origRun = _nes.run.bind(_nes);
    _nes.run = function() {
      const _origAnimate = requestAnimationFrame;
      _origRun();
      // frame counting is done via PPU frameComplete flag checked in original run loop
    };
  }

  // ── Public API exposed as window.LemonNES ─────────────────────────────────
  const LemonNES = {

    /** Load a ROM from a Base64-encoded string (passed from Kotlin via evaluateJavascript) */
    loadROM: function(base64) {
      try {
        if (!_nes) _init();
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        _nes.loadROM(bytes);
        return 'ok';
      } catch (e) {
        const msg = 'loadROM failed: ' + e.message;
        if (global.LemonBridge) global.LemonBridge.onError(msg);
        return msg;
      }
    },

    /** Load a ROM from a Uint8Array directly (for use within the page itself) */
    loadROMBytes: function(bytes) {
      try {
        if (!_nes) _init();
        _nes.loadROM(bytes);
        return 'ok';
      } catch(e) {
        const msg = 'loadROMBytes failed: ' + e.message;
        if (global.LemonBridge) global.LemonBridge.onError(msg);
        return msg;
      }
    },

    run: function() {
      if (!_nes) { console.warn('LemonNES: call loadROM first'); return; }
      _nes.run();
    },

    pause: function() {
      if (_nes) _nes.pause();
    },

    reset: function() {
      if (_nes) _nes.reset();
    },

    isRunning: function() {
      return _nes ? _nes.running : false;
    },

    /**
     * Inject a controller button press/release.
     * button: 'a' | 'b' | 'start' | 'select' | 'up' | 'down' | 'left' | 'right'
     * pressed: true | false
     */
    setButton: function(button, pressed) {
      if (_nes && _nes.input) _nes.input.setButton(0, button, pressed);
    },

    setVolume: function(vol) {
      Settings.audio.volume = Math.max(0, Math.min(1, vol));
    },

    setAudioEnabled: function(enabled) {
      Settings.audio.enabled = !!enabled;
    },

    setSpeed: function(speed) {
      Settings.emulation.speed = Math.max(0.25, Math.min(2.0, speed));
    },

    /** Returns a JSON string of the full save state, or null on failure */
    serializeState: function() {
      try {
        if (!_nes || !_nes.cpu) return null;
        return JSON.stringify(_nes.serializeState());
      } catch(e) {
        if (global.LemonBridge) global.LemonBridge.onError('serializeState: ' + e.message);
        return null;
      }
    },

    /** Restores emulator state from a JSON string previously returned by serializeState() */
    deserializeState: function(json) {
      try {
        if (!_nes || !_nes.cpu) throw new Error('No ROM loaded');
        _nes.deserializeState(JSON.parse(json));
        return 'ok';
      } catch(e) {
        const msg = 'deserializeState: ' + e.message;
        if (global.LemonBridge) global.LemonBridge.onError(msg);
        return msg;
      }
    }
  };

  // Expose globally
  global.LemonNES = LemonNES;
  window.LemonNES = LemonNES;
  // Auto-init once DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    _init();
  }

}(window));
