import { Module } from '@nestjs/common';
import { EventsConsumer } from './events-consumer.service';
import { IngestService } from './ingest.service';

/** The Redis stream `events` into Postgres; the consumer only runs when INGEST=on. */
@Module({
  providers: [IngestService, EventsConsumer],
  exports: [IngestService],
})
export class IngestModule {}
