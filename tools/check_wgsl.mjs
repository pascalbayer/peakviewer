#!/usr/bin/env node
/**
 * Build-time check for the shaders.
 *
 * WebGPU cannot run in the build environment, so this does the next best
 * thing: it puts the WGSL through Babylon's own preprocessor — the same code
 * path the engine uses to turn `attribute`/`uniform`/`varying` declarations
 * into bindings — and then parses the result. That catches the syntax and
 * declaration mistakes that would otherwise show up as a black screen on a
 * device.
 *
 * It does not type-check, and it cannot tell you the pipeline will link.
 */
import { WgslReflect } from '../node_modules/wgsl_reflect/wgsl_reflect.module.js';
import { build } from 'esbuild';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The shader sources are TypeScript; bundle them to something Node can import.
const bundled = await build({
  entryPoints: [join(root, 'src', 'render', 'gpu', 'wgsl.ts')],
  bundle: true, format: 'esm', write: false, platform: 'neutral', logLevel: 'error',
});
const tmp = join(root, 'node_modules', '.cache-wgsl');
mkdirSync(tmp, { recursive: true });
const modPath = join(tmp, 'wgsl.mjs');
writeFileSync(modPath, bundled.outputFiles[0].text);
const S = await import(`file://${modPath}`);

// Babylon 9 exports these as free functions rather than a namespace object.
const { Process, Initialize, Finalize } = await import(
  '@babylonjs/core/Engines/Processors/shaderProcessor.js');
const { WebGPUShaderProcessorWGSL } = await import(
  '@babylonjs/core/Engines/WebGPU/webgpuShaderProcessorsWGSL.js');
const { WebGPUShaderProcessingContext } = await import(
  '@babylonjs/core/Engines/WebGPU/webgpuShaderProcessingContext.js');

// One context per shader pair: it accumulates binding locations as it goes.
let ctx = null;
function newContext() {
  ctx = new WebGPUShaderProcessingContext(1 /* ShaderLanguage.WGSL */, false);
  return ctx;
}

function makeProcessor(context) {
  const processor = new WebGPUShaderProcessorWGSL();
  processor.pureMode = false;
  processor.shaderLanguage = 1;
  // The processor keeps the binding tables on itself; the same instance has to
  // see both stages and the finalize step.
  processor.initializeShaders?.(context);
  processor._webgpuProcessingContext = context;
  return processor;
}

function process(code, isFragment, context, processor) {
  const options = {
    defines: [],
    indexParameters: undefined,
    isFragment,
    shouldUseHighPrecisionShader: true,
    processor,
    supportsUniformBuffers: true,
    shadersRepository: '',
    includesShadersStore: {},
    version: '450',
    platformName: 'WEBGPU',
    processingContext: context,
    isNDCHalfZRange: true,
    useReverseDepthBuffer: false,
    vertexBufferKindToNumberOfComponents: {},
  };
  Initialize?.(options);
  return new Promise((res, rej) => {
    try {
      // A stand-in for the engine: the preprocessor only asks it for caps.
      const engineStub = {
        isWebGPU: true,
        _features: { needShaderCodeInlining: true },
        inlineShaderCode: (c) => c,
        getCaps: () => ({
          supportFloatTexturesResolve: false,
          textureFloatLinearFiltering: false,
          maxTextureSize: 8192,
          parallelShaderCompile: undefined,
        }),
      };
      Process(code, options, (out) => res(out), engineStub);
    } catch (e) { rej(e); }
  });
}

const pairs = [
  ['terrain', S.TERRAIN_VERTEX, S.TERRAIN_FRAGMENT, S.TERRAIN_UNIFORMS],
  ['composite', S.COMPOSITE_VERTEX, S.COMPOSITE_FRAGMENT, S.COMPOSITE_UNIFORMS],
];

let failures = 0;
for (const [name, vsSrc, fsSrc, expect] of pairs) {
  const ctx = newContext();
  let vs, fs;
  try {
    const processor = makeProcessor(ctx);
    vs = await process(vsSrc, false, ctx, processor);
    fs = await process(fsSrc, true, ctx, processor);
    const fin = Finalize(vs, fs, {
      processor,
      supportsUniformBuffers: true,
      isFragment: false,
      shouldUseHighPrecisionShader: true,
      defines: [],
      version: '450',
      platformName: 'WEBGPU',
      processingContext: ctx,
      isNDCHalfZRange: true,
      useReverseDepthBuffer: false,
      vertexBufferKindToNumberOfComponents: {},
    });
    vs = fin.vertexCode;
    fs = fin.fragmentCode;
  } catch (e) {
    console.error(`${name}: processing threw — ${String(e).split('\n')[0]}`);
    failures++;
    continue;
  }

  for (const [stage, code] of [['vertex', vs], ['fragment', fs]]) {
    writeFileSync(join(tmp, `${name}.${stage}.wgsl`), code);
    try {
      const r = new WgslReflect(code);
      const entry = [...r.entry.vertex, ...r.entry.fragment].map((e) => e.name).join(',');
      console.error(`${name}.${stage}: parsed — ${code.length} chars, entry [${entry}], `
        + `${r.uniforms.length} uniform blocks, ${r.textures.length} textures, `
        + `${r.samplers.length} samplers`);
      if (!entry) { console.error(`${name}.${stage}: NO ENTRY POINT`); failures++; }
    } catch (e) {
      console.error(`${name}.${stage}: PARSE ERROR — ${String(e).split('\n')[0]}`);
      console.error(`  written to ${join(tmp, `${name}.${stage}.wgsl`)}`);
      failures++;
    }
  }

  // Every declared uniform must land in the generated struct, and every name
  // the material sets must be one the shader actually declares.
  const both = vs + '\n' + fs;
  // Babylon binds the collected uniforms as `var<uniform> uniforms : X;` where
  // X is a generated struct name (LeftOver, today). Find it by the binding.
  const bind = /var<uniform>\s+uniforms\s*:\s*(\w+)\s*;/.exec(both);
  const struct = bind
    ? new RegExp(`struct\\s+${bind[1]}\\s*\\{([\\s\\S]*?)\\}`).exec(both)
    : null;
  const members = new Set(struct
    ? [...struct[1].matchAll(/^\s*([A-Za-z_]\w*)\s*:/gm)].map((m) => m[1])
    : []);
  const missing = expect.filter((u) => !members.has(u));
  if (missing.length) {
    console.error(`${name}: not in the generated uniform struct — ${missing.join(', ')}`);
    failures++;
  } else {
    console.error(`${name}: all ${expect.length} uniforms reached the struct`);
  }
  // A bare reference means a stripped declaration and an undeclared identifier.
  // Struct bodies are removed first: the same struct is emitted into both
  // stages, and its members are declarations, not references.
  const body = both.replace(/struct\s+\w+\s*\{[\s\S]*?\}/g, '');
  for (const u of expect) {
    const bare = new RegExp(`(?<![\\w.])${u}(?![\\w])`, 'g');
    if (bare.test(body)) {
      console.error(`${name}: ${u} referenced without the uniforms. prefix`);
      failures++;
    }
  }
}

if (failures) {
  console.error(`\n${failures} shader(s) failed the check.`);
  process.exitCode = 1;
} else {
  console.error('\nall shaders preprocess and parse.');
}
