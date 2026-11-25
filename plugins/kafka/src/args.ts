import { PluginError } from "@table-craft/plugin-api";
import { syntaxOf, type CommandDoc, type FlagDoc } from "./docs.js";
import type { Token } from "./tokens.js";

const LONG_PREFIX = "--";
const SHORT_FLAG = /^-[a-zA-Z]$/;
const WHOLE = /^\d+$/;

/** A command's arguments: its positional tokens, and each flag's values (a switch as `true`). */
export interface Arguments {
  readonly positional: readonly Token[];
  readonly flags: ReadonlyMap<string, readonly string[] | true>;
}

/** Whether a token is a flag: bare `--name` or `-p`, never quoted or JSON. */
export function isFlag(token: Token): boolean {
  if (token.quoted || token.json) return false;
  return (token.text.startsWith(LONG_PREFIX) && token.text.length > LONG_PREFIX.length) || SHORT_FLAG.test(token.text);
}

export function usage(doc: CommandDoc, message: string): PluginError {
  return new PluginError("statementFailed", `${doc.name}: ${message} Usage: ${syntaxOf(doc)}`);
}

/** The flag a token names, `--name`, `--name=value` or `-p`; null when the command has none such. */
export function flagOf(doc: CommandDoc, token: Token): { flag: FlagDoc | null; name: string; inline: string | null } {
  if (!token.text.startsWith(LONG_PREFIX)) {
    const short = token.text.slice(1);
    const flag = doc.flags.find((candidate) => candidate.short === short) ?? null;
    return { flag, name: flag?.name ?? short, inline: null };
  }
  const body = token.text.slice(LONG_PREFIX.length);
  const equals = body.indexOf("=");
  const name = equals < 0 ? body : body.slice(0, equals);
  return {
    flag: doc.flags.find((candidate) => candidate.name === name) ?? null,
    name,
    inline: equals < 0 ? null : body.slice(equals + 1),
  };
}

/** The arguments after a command's name, checked against its flags and its positional count. */
export function argumentsOf(doc: CommandDoc, tokens: readonly Token[]): Arguments {
  const positional: Token[] = [];
  const flags = new Map<string, string[] | true>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) continue;
    if (!isFlag(token)) {
      positional.push(token);
      continue;
    }
    const { flag, name, inline } = flagOf(doc, token);
    if (flag === null) {
      const known = doc.flags.map((candidate) => `--${candidate.name}`).join(", ");
      throw usage(doc, `there is no flag ${token.text}. ${known === "" ? "It takes no flags." : `It takes ${known}.`}`);
    }
    if (flag.value === undefined) {
      if (inline !== null) throw usage(doc, `--${name} takes no value.`);
      flags.set(name, true);
      continue;
    }
    let value = inline;
    if (value === null) {
      const next = tokens[index + 1];
      if (next === undefined) throw usage(doc, `--${name} needs a value: --${name} <${flag.value}>.`);
      value = next.text;
      index += 1;
    }
    const known = flags.get(name);
    if (known !== undefined && flag.repeat !== true) throw usage(doc, `--${name} is given twice.`);
    flags.set(name, [...(known === true || known === undefined ? [] : known), value]);
  }
  const required = doc.parameters.filter((parameter) => parameter.optional !== true).length;
  const variadic = doc.parameters.some((parameter) => parameter.variadic === true);
  if (positional.length < required || (!variadic && positional.length > doc.parameters.length)) {
    throw usage(
      doc,
      `expects ${required === doc.parameters.length ? String(required) : `${String(required)} to ${String(doc.parameters.length)}`} arguments, got ${String(positional.length)}.`,
    );
  }
  return { positional, flags };
}

/** A flag's single value; null when absent. */
export function flagValue(args: Arguments, name: string): string | null {
  const value = args.flags.get(name);
  return value === undefined || value === true ? null : (value.at(-1) ?? null);
}

export function flagValues(args: Arguments, name: string): readonly string[] {
  const value = args.flags.get(name);
  return value === undefined || value === true ? [] : value;
}

export function hasFlag(args: Arguments, name: string): boolean {
  return args.flags.has(name);
}

/** A whole number argument, refused with the command's usage when it is not one. */
export function wholeNumber(doc: CommandDoc, what: string, text: string): number {
  if (!WHOLE.test(text)) throw usage(doc, `${what} is a whole number, not ${text}.`);
  return Number(text);
}

/** A comma-separated partition list, `0,3,5`. */
export function partitionList(doc: CommandDoc, text: string): number[] {
  return text.split(",").map((part) => wholeNumber(doc, "a partition", part.trim()));
}

/** `k=v`, refused when it has no `=`. */
export function keyValue(doc: CommandDoc, text: string): { name: string; value: string } {
  const equals = text.indexOf("=");
  if (equals <= 0) throw usage(doc, `${text} is not k=v.`);
  return { name: text.slice(0, equals), value: text.slice(equals + 1) };
}
