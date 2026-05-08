import { customAlphabet } from "nanoid";

const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
const make = customAlphabet(alphabet, 12);

export function eventId(): string {
  return `evt_${make()}`;
}

export function memoryId(): string {
  return `mem_${make()}`;
}
