# portfolio.mol.la

Personal portfolio of Muhammad Sumon Molla Selim, built for the AWS Student Builder Challenge.

## Creative feature: "Do you know how you got here?"

On landing, the hero asks the visitor that question, then plays an animated "live replay" of how *this* page reached them, built from their own connection data. A video-style player (play/pause, chapter scrubber, retrace) drives a hop-by-hop inspector below it:

1. **You**: protocol (h2/h3) and page size from the Navigation Timing API
2. **DNS**: re-resolves the hostname via DNS-over-HTTPS and shows the CNAME into CloudFront
3. **Handshake**: TCP/QUIC and TLS timings, with an animated handshake diagram
4. **Edge**: the CloudFront location that served the visitor (`x-amz-cf-pop`) and the cache status (`x-cache`)
5. **Origin**: whether the edge answered from cache or went to the Amplify origin
6. **Delivered**: which security headers protected the response, and an evidence log sealed with SHA-256 (Web Crypto)

Retrace re-probes the edge and DNS, so a second run often shows the cache warming from MISS to HIT.

## AWS services

- **AWS Amplify Hosting**: CI/CD from GitHub, hosting, custom domain
- **Amazon CloudFront**: global edge delivery (managed by Amplify)
- **AWS Certificate Manager**: TLS certificate for `portfolio.mol.la` (managed by Amplify)

## Structure

```
site/            static site deployed by Amplify (amplify.yml → baseDirectory: site)
  js/trace-core.js   pure, unit-tested trace helpers
  js/player.js       animated replay scene and player controls
  js/main.js         DOM and network glue
  fonts/             JetBrains Mono (SIL OFL 1.1, see fonts/OFL.txt), self-hosted for a strict CSP
customHttp.yml   security headers (CSP, HSTS, framing, MIME, referrer, permissions)
tests/           node:test unit tests
```

## Run locally

```sh
docker compose up web                       # http://localhost:8088
docker compose --profile test run --rm test # unit tests
```
