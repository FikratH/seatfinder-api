import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { AppModule } from './app.module';
import { randomUUID } from 'crypto';

// Polyfill global crypto.randomUUID for Node 18 environments.
// @nestjs/schedule calls crypto.randomUUID without importing the module.
if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto.randomUUID) {
  (globalThis as any).crypto = {
    ...(globalThis as any).crypto,
    randomUUID: () => randomUUID(),
  };
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Explicit socket.io adapter (also lets us tune later: redis, sticky, etc.)
  app.useWebSocketAdapter(new IoAdapter(app));

  // Enable CORS
  const corsOrigin = process.env.CORS_ORIGIN;
  app.enableCors({
    origin: corsOrigin === '*' || !corsOrigin ? '*' : corsOrigin.split(','),
    credentials: true,
  });

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Swagger API documentation
  const config = new DocumentBuilder()
    .setTitle('HKU Seat Finder API')
    .setDescription('API for HKU Seat Finder - Find available study seats')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  const port = process.env.API_PORT || 3001;
  await app.listen(port, '0.0.0.0'); // Listen on all network interfaces
  console.log(`🚀 API server running on http://0.0.0.0:${port}`);
  console.log(`📚 API docs available at http://localhost:${port}/api/docs`);
}

bootstrap();
