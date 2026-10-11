import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
for (const [src, dst] of [['/home/user/claudetest/assets/ironman-mk/ironman.glb', '../cine/ironman.glb'], ['/home/user/claudetest/assets/thanos/thanos.glb', '../cine/thanos.glb']]) {
  const doc = await io.read(src);
  const used = doc.getRoot().listExtensionsUsed().map((e) => e.extensionName);
  for (const e of doc.getRoot().listExtensionsUsed()) if (/meshopt/i.test(e.extensionName)) e.dispose();
  await io.write(dst, doc);
  console.log(src.split('/').pop(), 'extensions', used.join(','));
}
