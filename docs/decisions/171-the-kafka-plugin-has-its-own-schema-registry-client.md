# 171: The Kafka plugin has its own Schema Registry client

Status: Accepted

## Decision

The Kafka plugin talks to a Schema Registry through its own small client over `fetch`, speaking
the Confluent REST API: subjects, versions, schema by id, compatibility checks and levels,
register and delete. It decodes Avro with `avsc` and Protobuf with `protobufjs` (including the
message-index varints after the Confluent prefix), validates JSON Schema itself, and caches
schemas by id for the life of a session. Authentication is none or basic; an `https` registry uses
the connection's CA file.

## Rationale

The driver's own registry support is marked experimental and outside semantic versioning, so a
minor driver update could change how every Avro topic decodes. The REST API is small, stable and
served the same way by Confluent's registry, Redpanda's built-in one and Apicurio's compatibility
endpoint. Owning the client also keeps the registry optional: a datasource without a URL never
loads the decoders' schemas or reaches a second server.

## Consequences

The plugin carries `avsc` and `protobufjs`, both pure JavaScript, so it stays one package for
every platform. The tests run the registry client against an in-process mock of the REST API, and
the Avro round trip through a real broker. A registry feature the client does not speak (schema
contexts, data contracts) is out of reach until the client grows it.
