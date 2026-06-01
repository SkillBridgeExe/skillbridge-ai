import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Request, Response } from 'express';

export async function setupOpenApi(app: INestApplication, config: ConfigService): Promise<void> {
  const enabled = config.get<boolean>('API_DOCS_ENABLED') ?? true;
  if (!enabled) return;

  const docsPath = trimSlashes(config.get<string>('API_DOCS_PATH') ?? 'reference');
  const jsonPath = trimSlashes(config.get<string>('OPENAPI_JSON_PATH') ?? 'openapi.json');
  const port = config.get<number>('PORT') ?? 3002;

  const openApiConfig = new DocumentBuilder()
    .setTitle('SkillBridge Backend API')
    .setDescription('Public platform API and guarded internal AI endpoints for SkillBridge.')
    .setVersion('0.1.0')
    .addServer(`http://localhost:${port}`, 'Local')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, openApiConfig);

  app.use(`/${jsonPath}`, (_req: Request, res: Response) => {
    res.json(document);
  });

  if (process.env.NODE_ENV === 'test') {
    app.use(`/${docsPath}`, (_req: Request, res: Response) => {
      res.type('html').send('<!doctype html><html><body>Scalar API Reference</body></html>');
    });
    return;
  }

  const { apiReference } = await import('@scalar/nestjs-api-reference');
  app.use(`/${docsPath}`, apiReference({ url: `/${jsonPath}` }));
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, '');
}
