#!/usr/bin/env node

import { Command } from 'commander';
import * as path from 'path';
import { ProjectScanner } from '../core/scanner';
import { SignatureExporter } from '../core/exporter';
import { FileWatcher } from '../core/watcher';
import { ExportOptions } from '../types';

const program = new Command();

program
  .name('sigscan')
  .description(
    'The ultimate Solidity development toolkit — gas analysis, security audits, on-chain inspection, Foundry/Hardhat integration, and more'
  )
  .version('0.1.0');

program
  .command('scan')
  .description('Scan project for contract signatures (recursively finds all subprojects)')
  .option('-p, --path <path>', 'Project path', process.cwd())
  .option('-o, --output <dir>', 'Output directory name (relative to each subproject)', 'signatures')
  .option('-f, --formats <formats>', 'Export formats (txt,json,csv,md)', 'txt,json')
  .option('--include-internal', 'Include internal functions', false)
  .option('--include-private', 'Include private functions', false)
  .option('--include-events', 'Include events', true)
  .option('--include-errors', 'Include errors', true)
  .option('--recursive', 'Recursively scan for subprojects', true)
  .action(async (options) => {
    try {
      const scanner = new ProjectScanner();
      const exporter = new SignatureExporter();

      console.log(`Scanning project: ${options.path}`);

      if (options.recursive) {
        // Recursive scan for all subprojects
        const { subProjects, combinedResult } = await scanner.scanAllSubProjects(options.path);

        console.log(`\nFound ${subProjects.length} project(s):`);
        subProjects.forEach((sp) => {
          console.log(`  - ${sp.path} (${sp.type})`);
        });

        console.log(`\nTotal contracts: ${combinedResult.totalContracts}`);
        console.log(`Total functions: ${combinedResult.totalFunctions}`);
        console.log(`Total events: ${combinedResult.totalEvents}`);
        console.log(`Total errors: ${combinedResult.totalErrors}`);

        // Export to each subproject's signatures folder
        for (const subProject of subProjects) {
          if (!subProject.scanResult || subProject.scanResult.totalContracts === 0) {
            continue;
          }

          const outputDir = path.join(subProject.path, options.output);

          const exportOptions: ExportOptions = {
            formats: options.formats.split(',').map((f: string) => f.trim()),
            outputDir,
            includeInternal: options.includeInternal,
            includePrivate: options.includePrivate,
            includeEvents: options.includeEvents,
            includeErrors: options.includeErrors,
            separateByCategory: true,
            updateExisting: true,
            deduplicateSignatures: true,
          };

          await exporter.exportSignatures(subProject.scanResult, exportOptions);
          console.log(`Signatures exported to: ${outputDir}`);
        }
      } else {
        // Single project scan (legacy behavior)
        const scanResult = await scanner.scanProject(options.path);

        console.log(`Found ${scanResult.totalContracts} contracts`);
        console.log(`Total functions: ${scanResult.totalFunctions}`);
        console.log(`Total events: ${scanResult.totalEvents}`);
        console.log(`Total errors: ${scanResult.totalErrors}`);

        const exportOptions: ExportOptions = {
          formats: options.formats.split(',').map((f: string) => f.trim()),
          outputDir: path.resolve(options.output),
          includeInternal: options.includeInternal,
          includePrivate: options.includePrivate,
          includeEvents: options.includeEvents,
          includeErrors: options.includeErrors,
          separateByCategory: true,
          updateExisting: true,
          deduplicateSignatures: true,
        };

        await exporter.exportSignatures(scanResult, exportOptions);
        console.log(`Signatures exported to: ${exportOptions.outputDir}`);
      }
    } catch (error) {
      console.error('Error scanning project:', error);
      process.exit(1);
    }
  });

program
  .command('watch')
  .description('Watch project for changes and auto-scan (recursively watches all subprojects)')
  .option('-p, --path <path>', 'Project path', process.cwd())
  .option('-o, --output <dir>', 'Output directory name (relative to each subproject)', 'signatures')
  .option('-f, --formats <formats>', 'Export formats (txt,json,csv,md)', 'txt,json')
  .option('--include-internal', 'Include internal functions', false)
  .option('--include-private', 'Include private functions', false)
  .option('--include-events', 'Include events', true)
  .option('--include-errors', 'Include errors', true)
  .action(async (options) => {
    try {
      const scanner = new ProjectScanner();
      const exporter = new SignatureExporter();
      const watcher = new FileWatcher();

      // Initial scan with recursive subproject detection
      console.log(`Initial scan of project: ${options.path}`);
      let { subProjects } = await scanner.scanAllSubProjects(options.path);

      console.log(`Found ${subProjects.length} project(s):`);
      subProjects.forEach((sp) => {
        console.log(`  - ${sp.path} (${sp.type})`);
      });

      // Export to each subproject
      for (const subProject of subProjects) {
        if (!subProject.scanResult || subProject.scanResult.totalContracts === 0) {
          continue;
        }

        const outputDir = path.join(subProject.path, options.output);

        const exportOptions: ExportOptions = {
          formats: options.formats.split(',').map((f: string) => f.trim()),
          outputDir,
          includeInternal: options.includeInternal,
          includePrivate: options.includePrivate,
          includeEvents: options.includeEvents,
          includeErrors: options.includeErrors,
          separateByCategory: true,
          updateExisting: true,
          deduplicateSignatures: true,
        };

        await exporter.exportSignatures(subProject.scanResult, exportOptions);
        console.log(`Initial export completed: ${outputDir}`);
      }

      // Start watching all subprojects
      console.log('Watching for changes... (Press Ctrl+C to stop)');

      for (const subProject of subProjects) {
        if (subProject.scanResult) {
          watcher.startWatching(subProject.scanResult.projectInfo);
        }
      }

      const handleFileChange = async (filePath: string, contractInfo: unknown) => {
        console.log(`File changed: ${filePath}`);
        if (contractInfo) {
          // Re-scan and export
          const updated = await scanner.scanAllSubProjects(options.path);
          subProjects = updated.subProjects;

          for (const sp of subProjects) {
            if (sp.scanResult && sp.scanResult.totalContracts > 0) {
              const outputDir = path.join(sp.path, options.output);
              const exportOptions: ExportOptions = {
                formats: options.formats.split(',').map((f: string) => f.trim()),
                outputDir,
                includeInternal: options.includeInternal,
                includePrivate: options.includePrivate,
                includeEvents: options.includeEvents,
                includeErrors: options.includeErrors,
                separateByCategory: true,
                updateExisting: true,
                deduplicateSignatures: true,
              };
              await exporter.exportSignatures(sp.scanResult, exportOptions);
            }
          }
          console.log('Signatures updated');
        }
      };

      watcher.on('fileChanged', handleFileChange);
      watcher.on('fileAdded', handleFileChange);

      watcher.on('fileRemoved', async (filePath) => {
        console.log(`File removed: ${filePath}`);
        // Re-scan and export
        const updated = await scanner.scanAllSubProjects(options.path);
        subProjects = updated.subProjects;

        for (const sp of subProjects) {
          if (sp.scanResult && sp.scanResult.totalContracts > 0) {
            const outputDir = path.join(sp.path, options.output);
            const exportOptions: ExportOptions = {
              formats: options.formats.split(',').map((f: string) => f.trim()),
              outputDir,
              includeInternal: options.includeInternal,
              includePrivate: options.includePrivate,
              includeEvents: options.includeEvents,
              includeErrors: options.includeErrors,
              separateByCategory: true,
              updateExisting: true,
              deduplicateSignatures: true,
            };
            await exporter.exportSignatures(sp.scanResult, exportOptions);
          }
        }
        console.log('Signatures updated');
      });

      watcher.on('error', (error) => {
        console.error('Watcher error:', error);
      });

      // Handle graceful shutdown
      process.on('SIGINT', () => {
        console.log('\nStopping watcher...');
        watcher.stopWatching();
        process.exit(0);
      });
    } catch (error) {
      console.error('Error watching project:', error);
      process.exit(1);
    }
  });

program
  .command('info')
  .description('Show project information (detects all subprojects)')
  .option('-p, --path <path>', 'Project path', process.cwd())
  .action(async (options) => {
    try {
      const scanner = new ProjectScanner();
      const { subProjects, combinedResult } = await scanner.scanAllSubProjects(options.path);

      console.log('Project Information:');
      console.log(`  Root Path: ${options.path}`);
      console.log(`  Subprojects Found: ${subProjects.length}`);
      console.log('');

      subProjects.forEach((sp, index) => {
        console.log(`  [${index + 1}] ${sp.path}`);
        console.log(`      Type: ${sp.type}`);
        if (sp.scanResult) {
          console.log(`      Contracts: ${sp.scanResult.totalContracts}`);
          console.log(`      Functions: ${sp.scanResult.totalFunctions}`);
          console.log(`      Events: ${sp.scanResult.totalEvents}`);
          console.log(`      Errors: ${sp.scanResult.totalErrors}`);
        }
        console.log('');
      });

      console.log('Combined Statistics:');
      console.log(`  Total Contracts: ${combinedResult.totalContracts}`);
      console.log(`  Total Functions: ${combinedResult.totalFunctions}`);
      console.log(`  Total Events: ${combinedResult.totalEvents}`);
      console.log(`  Total Errors: ${combinedResult.totalErrors}`);
    } catch (error) {
      console.error('Error getting project info:', error);
      process.exit(1);
    }
  });

program.parse();
