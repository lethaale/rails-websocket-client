# syntax=docker/dockerfile:1
# Build context: this directory (script/go-websockets).
# Build: docker build -t <user>/rails_websocket_client_listener script/go-websockets/

FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# modernc.org/sqlite is pure Go, so we can build static and ship on distroless.
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/listener .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/listener /listener
ENV DB_PATH=/storage/queue.sqlite3 \
    WS_URL=wss://stream.binance.com:9443/ws/btcusdt@trade
ENTRYPOINT ["/listener"]
