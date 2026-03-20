import type { RawData } from 'ws';
import type { WSMessage } from '../types';

function rawDataToText(raw: RawData): string {
    if (typeof raw === 'string') return raw;
    if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf-8');
    if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf-8');
    return raw.toString('utf-8');
}

export function decodeWsMessage(raw: RawData): WSMessage {
    const payload = rawDataToText(raw);
    return JSON.parse(payload) as WSMessage;
}
