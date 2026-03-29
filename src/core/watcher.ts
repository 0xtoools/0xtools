import * as chokidar from 'chokidar';
import * as path from 'path';
import { EventEmitter } from 'events';
import { ProjectInfo, ContractInfo } from '../types';
import { SolidityParser } from './parser';

export interface WatcherEvents {
  fileChanged: (filePath: string, contractInfo: ContractInfo | null) => void;
  fileAdded: (filePath: string, contractInfo: ContractInfo | null) => void;
  fileRemoved: (filePath: string) => void;
  error: (error: Error) => void;
}

export class FileWatcher extends EventEmitter {
  private watcher: chokidar.FSWatcher | null = null;
  private parser: SolidityParser;
  private isWatching = false;
  private changeTimers: Map<string, NodeJS.Timeout> = new Map();
  private static readonly CHANGE_DEBOUNCE_MS = 300;

  constructor() {
    super();
    this.parser = new SolidityParser();
  }

  /**
   * Start watching for file changes
   */
  public startWatching(projectInfo: ProjectInfo): void {
    if (this.isWatching) {
      return;
    }

    const watchPaths = projectInfo.contractDirs.map((dir) =>
      path.join(projectInfo.rootPath, dir, '**/*.sol')
    );

    this.watcher = chokidar.watch(watchPaths, {
      ignored: /node_modules/,
      persistent: true,
      ignoreInitial: true,
    });

    this.watcher
      .on('add', (filePath: string) => {
        const contractInfo = this.parser.parseFile(filePath);
        this.emit('fileAdded', filePath, contractInfo);
      })
      .on('change', (filePath: string) => {
        // Debounce change events to avoid redundant re-parses on rapid saves
        const existing = this.changeTimers.get(filePath);
        if (existing) {
          clearTimeout(existing);
        }
        const timer = setTimeout(() => {
          this.changeTimers.delete(filePath);
          const contractInfo = this.parser.parseFile(filePath);
          this.emit('fileChanged', filePath, contractInfo);
        }, FileWatcher.CHANGE_DEBOUNCE_MS);
        this.changeTimers.set(filePath, timer);
      })
      .on('unlink', (filePath: string) => {
        // Cancel any pending change timer for the removed file
        const pending = this.changeTimers.get(filePath);
        if (pending) {
          clearTimeout(pending);
          this.changeTimers.delete(filePath);
        }
        this.emit('fileRemoved', filePath);
      })
      .on('error', (error: Error) => {
        this.emit('error', error);
      });

    this.isWatching = true;
  }

  /**
   * Stop watching for file changes
   */
  public async stopWatching(): Promise<void> {
    // Cancel all pending debounce timers
    for (const timer of this.changeTimers.values()) {
      clearTimeout(timer);
    }
    this.changeTimers.clear();

    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    this.isWatching = false;
    this.removeAllListeners();
  }

  /**
   * Check if currently watching
   */
  public getWatchingStatus(): boolean {
    return this.isWatching;
  }

  /**
   * Get watched paths
   */
  public getWatchedPaths(): string[] {
    if (!this.watcher) {
      return [];
    }

    const watched = this.watcher.getWatched();
    const paths: string[] = [];

    Object.keys(watched).forEach((dir) => {
      watched[dir].forEach((file) => {
        if (file.endsWith('.sol')) {
          paths.push(path.join(dir, file));
        }
      });
    });

    return paths;
  }
}
