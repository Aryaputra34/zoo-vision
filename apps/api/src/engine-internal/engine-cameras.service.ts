import { Injectable } from '@nestjs/common';
import { UrlCipher } from '../cameras/url-cipher';
import { ContractsService } from '../contracts/contracts.service';
import { ModelsService } from '../models/models.service';
import { PrismaService } from '../prisma/prisma.service';

export type EngineCamera = {
  id: string;
  name: string;
  useCase: string;
  /** Camera.activeVersion. */
  version: number;
  /** Of that version. */
  schemaVersion: number;
  /** The active version's settings with schema defaults filled in. */
  settings: Record<string, unknown>;
  /** Decrypted. Never log it. */
  sourceUrl: string;
  targetFps: number;
  nxCameraId: string | null;
  /** `path` is relative to the models directory: the registry row of `model_id`, else `model_name`. */
  model: { path: string; imgsz: number | [number, number] };
};

@Injectable()
export class EngineCamerasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly contracts: ContractsService,
    private readonly cipher: UrlCipher,
    private readonly models: ModelsService,
  ) {}

  /** The enabled cameras of an engine group, sorted by id. */
  async snapshot(group: string): Promise<EngineCamera[]> {
    const cameras = await this.prisma.camera.findMany({
      where: { enabled: true, engineGroup: group },
      orderBy: { id: 'asc' },
    });
    if (cameras.length === 0) return [];
    const versions = await this.prisma.cameraConfigVersion.findMany({
      where: {
        OR: cameras.map((c) => ({ cameraId: c.id, version: c.activeVersion })),
      },
    });
    const byCamera = new Map(versions.map((v) => [v.cameraId, v]));

    const out: EngineCamera[] = [];
    for (const camera of cameras) {
      const active = byCamera.get(camera.id);
      if (!active) continue; // cannot happen: activeVersion always names a stored version
      const settings = this.contracts.validator.withDefaults(
        camera.useCase,
        active.settings as object,
      ) as Record<string, unknown>;
      const modelId = settings.model_id as string | undefined;
      const registryFile = modelId
        ? await this.models.resolvePath(modelId)
        : null;
      const useSub = camera.inferenceStream === 'SUB' && camera.subStreamUrlEnc;
      out.push({
        id: camera.id,
        name: camera.name,
        useCase: camera.useCase,
        version: camera.activeVersion,
        schemaVersion: active.schemaVersion,
        settings,
        sourceUrl: this.cipher.decrypt(
          useSub ? camera.subStreamUrlEnc! : camera.mainStreamUrlEnc,
        ),
        targetFps: camera.targetFps,
        nxCameraId: camera.nxCameraId,
        model: {
          path: registryFile ?? (settings.model_name as string),
          imgsz: settings.imgsz as number | [number, number],
        },
      });
    }
    return out;
  }
}
