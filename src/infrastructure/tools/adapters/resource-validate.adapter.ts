import { Injectable } from '@nestjs/common';
import { ToolAdapter, ToolBadArgsError, ToolContext } from '../types';
import { LinkProbeResult, probeUrl } from './link-probe';

export interface ResourceValidateArgs {
  url: string;
}

@Injectable()
export class ResourceValidateAdapter implements ToolAdapter<ResourceValidateArgs, LinkProbeResult> {
  readonly name = 'resource.validate';

  argsSchema(args: unknown): ResourceValidateArgs {
    const url = (args as { url?: unknown })?.url;
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      throw new ToolBadArgsError('resource.validate requires a valid http(s) url');
    }
    return { url };
  }

  async invoke(args: ResourceValidateArgs, _ctx: ToolContext): Promise<LinkProbeResult> {
    return probeUrl(args.url);
  }
}
