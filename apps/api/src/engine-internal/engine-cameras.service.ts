import { Inject, Injectable } from '@nestjs/common';
import { UrlCipher } from '../cameras/url-cipher';
import type { Camera } from '../generated/prisma/client';
import { ENV, type Env } from '../config/env';
import { ContractsService } from '../contracts/contracts.service';
import { mediamtxPaths } from '../mediamtx/paths';
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
  /** Contains credentials (the camera's or MediaMTX's). Never log it. */
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
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * With MediaMTX configured the engine reads every non-FILE camera through it (one connection
   * per camera, recording and live view share it). The engine runs on the MediaMTX host (host
   * network or from source), so 127.0.0.1:8554 is fixed. The password may hold `@ : / #`: it is
   * percent-encoded, the camera's own URL never appears here.
   */
  private sourceUrl(camera: Camera): string {
    const paths = mediamtxPaths(camera);
    const { MEDIAMTX_API_URL, MEDIAMTX_PASSWORD } = this.env;
    if (paths && MEDIAMTX_API_URL && MEDIAMTX_PASSWORD) {
      return `rtsp://zoo:${encodeURIComponent(MEDIAMTX_PASSWORD)}@127.0.0.1:8554/${paths.engine}`;
    }
    const useSub = camera.inferenceStream === 'SUB' && camera.subStreamUrlEnc;
    return this.cipher.decrypt(
      useSub ? camera.subStreamUrlEnc! : camera.mainStreamUrlEnc,
    );
  }

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
      out.push({
        id: camera.id,
        name: camera.name,
        useCase: camera.useCase,
        version: camera.activeVersion,
        schemaVersion: active.schemaVersion,
        settings,
        sourceUrl: this.sourceUrl(camera),
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
