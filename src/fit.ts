// Minimal FIT encoder port of python-garminconnect's FitEncoderWeight (weight-scale upload)
const CRC_TABLE = [
  0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401, 0xa001, 0x6c00, 0x7800, 0xb401,
  0x5000, 0x9c01, 0x8801, 0x4400,
];

function crc16(bytes: Uint8Array): number {
  let crc = 0;
  for (const b of bytes) {
    let tmp = CRC_TABLE[crc & 0xf];
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[b & 0xf];
    tmp = CRC_TABLE[crc & 0xf];
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[(b >> 4) & 0xf];
  }
  return crc;
}

interface BT {
  code: number;
  size: number;
  invalid: number;
}
const ENUM: BT = { code: 0x00, size: 1, invalid: 0xff };
const UINT8: BT = { code: 0x02, size: 1, invalid: 0xff };
const UINT16: BT = { code: 0x84, size: 2, invalid: 0xffff };
const UINT32: BT = { code: 0x86, size: 4, invalid: 0xffffffff };
const UINT32Z: BT = { code: 0x8c, size: 4, invalid: 0 };

type Field = [num: number, bt: BT, value: number | null, scale: number | null];

class Writer {
  bytes: number[] = [];
  u8(v: number) {
    this.bytes.push(v & 0xff);
  }
  u16(v: number) {
    this.u8(v);
    this.u8(Math.floor(v / 256));
  }
  u32(v: number) {
    this.u16(v % 65536);
    this.u16(Math.floor(v / 65536));
  }
  value(bt: BT, v: number) {
    if (bt.size === 1) this.u8(v);
    else if (bt.size === 2) this.u16(v);
    else this.u32(v);
  }
  message(lmsg: number, globalNum: number, fields: Field[]) {
    this.u8(0x40 | lmsg);
    this.u8(0);
    this.u8(0); // little endian
    this.u16(globalNum);
    this.u8(fields.length);
    for (const [num, bt] of fields) {
      this.u8(num);
      this.u8(bt.size);
      this.u8(bt.code);
    }
    this.u8(lmsg);
    for (const [, bt, value, scale] of fields) {
      const v = value === null ? bt.invalid : Math.trunc(value * (scale ?? 1));
      this.value(bt, v);
    }
  }
}

export interface WeightFitFields {
  weight: number; // kg
  percent_fat?: number;
  percent_hydration?: number;
  visceral_fat_mass?: number;
  bone_mass?: number;
  muscle_mass?: number;
  basal_met?: number;
  active_met?: number;
  physique_rating?: number;
  metabolic_age?: number;
  visceral_fat_rating?: number;
  bmi?: number;
}

export function encodeWeightFit(epochSeconds: number, f: WeightFitFields): Uint8Array {
  const ts = epochSeconds - 631065600; // FIT epoch: 1989-12-31 UTC
  const opt = (v: number | undefined): number | null => (v === undefined ? null : v);
  const w = new Writer();

  // file_id (global 0, lmsg 0), field order matches the python encoder
  w.message(0, 0, [
    [3, UINT32Z, null, null],
    [4, UINT32, ts, null],
    [1, UINT16, null, null],
    [2, UINT16, null, null],
    [5, UINT16, null, null],
    [0, ENUM, 9, null], // file type 9 = weight
  ]);
  // file_creator (global 49, lmsg 1)
  w.message(1, 49, [
    [0, UINT16, null, null],
    [1, UINT8, null, null],
  ]);
  // device_info (global 23, lmsg 2)
  w.message(2, 23, [
    [253, UINT32, ts, 1],
    [3, UINT32Z, null, 1],
    [7, UINT32, null, 1],
    [8, UINT32, null, null],
    [2, UINT16, null, 1],
    [4, UINT16, null, 1],
    [5, UINT16, null, 100],
    [10, UINT16, null, 256],
    [0, UINT8, null, 1],
    [1, UINT8, null, 1],
    [6, UINT8, null, 1],
    [11, UINT8, null, null],
  ]);
  // weight_scale (global 30, lmsg 3)
  w.message(3, 30, [
    [253, UINT32, ts, 1],
    [0, UINT16, f.weight, 100],
    [1, UINT16, opt(f.percent_fat), 100],
    [2, UINT16, opt(f.percent_hydration), 100],
    [3, UINT16, opt(f.visceral_fat_mass), 100],
    [4, UINT16, opt(f.bone_mass), 100],
    [5, UINT16, opt(f.muscle_mass), 100],
    [7, UINT16, opt(f.basal_met), 4],
    [9, UINT16, opt(f.active_met), 4],
    [8, UINT8, opt(f.physique_rating), 1],
    [10, UINT8, opt(f.metabolic_age), 1],
    [11, UINT8, opt(f.visceral_fat_rating), 1],
    [13, UINT16, opt(f.bmi), 10],
  ]);

  // 12-byte header + data + crc
  const data = new Uint8Array(w.bytes);
  const file = new Uint8Array(12 + data.length + 2);
  const dv = new DataView(file.buffer);
  dv.setUint8(0, 12);
  dv.setUint8(1, 16); // protocol version
  dv.setUint16(2, 108, true); // profile version
  dv.setUint32(4, data.length, true);
  file.set([0x2e, 0x46, 0x49, 0x54], 8); // ".FIT"
  file.set(data, 12);
  dv.setUint16(12 + data.length, crc16(file.subarray(0, 12 + data.length)), true);
  return file;
}
