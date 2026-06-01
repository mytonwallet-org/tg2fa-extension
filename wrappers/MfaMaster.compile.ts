import { CompilerConfig } from '@ton/blueprint';

export const compile: CompilerConfig = {
  lang: 'func',
  targets: ['contracts/mfa_master.fc']
};