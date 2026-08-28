import { customAlphabet } from 'nanoid';

const nano = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 8);
export const createOrderNumber = () => `SM-${new Date().getFullYear()}-${nano()}`;
