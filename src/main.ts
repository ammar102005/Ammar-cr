import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './api';
async function main() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.useBodyParser('json', { limit: '8mb' }); // designs can embed logos (each capped at ~1.5MB by the schema)
  app.enableCors({ origin: process.env.WEB_ORIGIN ? process.env.WEB_ORIGIN.split(',') : false });
  app.set('trust proxy', 1);
  await app.listen(+(process.env.PORT || 3000));
}
main();
