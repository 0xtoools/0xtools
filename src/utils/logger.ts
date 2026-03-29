import * as vscode from 'vscode';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

class Logger {
  private channel: vscode.OutputChannel | null = null;
  private minLevel: LogLevel = 'info';

  /**
   * Initialize the output channel. Must be called during extension activation.
   */
  init(context: vscode.ExtensionContext): void {
    this.channel = vscode.window.createOutputChannel('0xTools');
    context.subscriptions.push(this.channel);

    const config = vscode.workspace.getConfiguration('sigscan');
    this.minLevel = (config.get<string>('logLevel') as LogLevel) || 'info';
  }

  setLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  debug(message: string, ...args: unknown[]): void {
    this.log('debug', message, ...args);
  }

  info(message: string, ...args: unknown[]): void {
    this.log('info', message, ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.log('warn', message, ...args);
  }

  error(message: string, ...args: unknown[]): void {
    this.log('error', message, ...args);
  }

  /**
   * Show the output channel in VS Code.
   */
  show(): void {
    this.channel?.show(true);
  }

  private log(level: LogLevel, message: string, ...args: unknown[]): void {
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[this.minLevel]) {
      return;
    }

    const timestamp = new Date().toISOString().slice(11, 23);
    const tag = level.toUpperCase().padEnd(5);
    const suffix = args.length > 0 ? ' ' + args.map((a) => String(a)).join(' ') : '';
    const line = `[${timestamp}] [${tag}] ${message}${suffix}`;

    if (this.channel) {
      this.channel.appendLine(line);
    }

    // Mirror errors/warnings to the dev console for debugging
    if (level === 'error') {
      console.error(`[0xTools] ${message}`, ...args);
    } else if (level === 'warn') {
      console.warn(`[0xTools] ${message}`, ...args);
    }
  }
}

/** Singleton logger instance. Call `logger.init(context)` during activation. */
export const logger = new Logger();
