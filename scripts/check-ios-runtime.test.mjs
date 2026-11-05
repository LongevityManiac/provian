import { describe, it, expect } from 'vitest';
import { parseUuids, assertMatchingRuntime } from './check-ios-runtime.mjs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { addRuntimeGuard, PHASE_NAME, addPostIntegrate } = require('../plugins/withIosRuntimeGuard.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = parseUuids('UUID: 80D5528F-2C78-3B90-B90F-747E89A9F880 (arm64) hermes');
const debug = parseUuids('UUID: 3CB559A9-19A5-3571-886A-934297F3E6E6 (arm64) hermes');

describe('iOS embedded runtime guard', () => {
  it('refuses the exact Debug Hermes UUID from the crashing Release app', () => {
    expect(() => assertMatchingRuntime(release, debug, 'hermes')).toThrow('hermes: arm64 runtime does not match');
    expect(() => assertMatchingRuntime(release, release, 'hermes')).not.toThrow();
  });
  it('refuses missing, unparseable and unsupported-architecture binaries', () => {
    expect(() => parseUuids('')).toThrow('no Mach-O UUIDs');
    expect(() => assertMatchingRuntime(release, new Map(), 'hermes')).toThrow('empty');
    expect(() => assertMatchingRuntime(new Map(), release, 'hermes')).toThrow('empty');
    expect(() => assertMatchingRuntime(release, new Map([['x86_64', 'other']]), 'hermes')).toThrow('x86_64');
  });
  it('permits an architecture stripped from a matching universal simulator framework', () => {
    const universal = new Map([...release, ['x86_64', 'second']]);
    expect(() => assertMatchingRuntime(universal, release, 'hermes')).not.toThrow();
  });
  it('prebuild preserves one always-running phase after framework embedding', () => {
    const project = require('xcode').project(path.join(root, 'ios/Provian.xcodeproj/project.pbxproj'));
    project.parseSync();
    const target = project.pbxNativeTargetSection()[project.getFirstTarget().uuid];
    target.buildPhases = target.buildPhases.filter(p => p.comment !== PHASE_NAME);
    expect(target.buildPhases.some(p => p.comment === PHASE_NAME)).toBe(false);
    addRuntimeGuard(project);
    // CocoaPods can append phases after Expo's plugin ran; regeneration must move ours last.
    project.addBuildPhase([], 'PBXShellScriptBuildPhase', 'Later embedding phase', project.getFirstTarget().uuid, { shellPath: '/bin/sh', shellScript: 'true' });
    addRuntimeGuard(project);
    const phases = project.pbxNativeTargetSection()[project.getFirstTarget().uuid].buildPhases;
    expect(phases.filter(p => p.comment === PHASE_NAME)).toHaveLength(1);
    expect(phases.at(-1).comment).toBe(PHASE_NAME);
    const phase = project.hash.project.objects.PBXShellScriptBuildPhase[phases.at(-1).value];
    expect(phase.alwaysOutOfDate).toBe(1);
    expect(phase.shellScript).toContain('check-ios-runtime.mjs');
  });
  it('normalizes phase order after pod install and refuses to overwrite another hook', () => {
    const podfile = 'target "Provian" do\nend\n';
    const withHook = addPostIntegrate(podfile);
    expect(withHook).toContain('post_integrate do |installer|');
    expect(withHook).toContain('target.build_phases << guard');
    expect(addPostIntegrate(withHook)).toBe(withHook);
    expect(() => addPostIntegrate('post_integrate do |installer|\nend\n')).toThrow('existing post_integrate');
  });
});
