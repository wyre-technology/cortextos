// conduit-prod vendor fleet — parameters (option-a Piece 1)
//
// using vendor-fleet.bicep. Deploys the 33 internal-sidecar vendor MCP
// Container Apps into conduit-prod-env (rg-conduit-prod).
//
// THE 33 — provenance
// -------------------
// The set is exactly the internal-sidecar vendors of conduit's
// src/credentials/vendor-config.ts — every entry whose containerUrl is
// `http://<slug>-mcp:8080`. The other 8 vendor-config entries (betterstack,
// hubspot, m365, pagerduty, pandadoc, pax8, rootly, runzero) are
// external-hosted MCP endpoints and need no container — they are not here.
//
// Each image is DIGEST-PINNED. Every digest below was resolved on 2026-05-20
// from `ghcr.io/wyre-technology/<slug>-mcp:latest` via
// `docker buildx imagetools inspect` — i.e. the exact image the mcp-gateway
// `gwp-*` prod fleet pulls (that fleet runs `:latest`; pinning the digest
// `:latest` currently resolves to gives conduit-prod a reproducible, prod-
// proven starting image). Multi-arch entries pin the OCI image-index digest;
// ACA resolves the linux/amd64 manifest from it. Ongoing image rolls are
// owned by option-a Piece 2 (the parameterized mcp-server-deploy.yml), not by
// re-pinning here.

using './vendor-fleet.bicep'

param containerEnvName = 'conduit-prod-env'

// GHCR read:packages PAT — supplied at deploy time from conduit-prod-kv
// (secret `ghcr-token`) as the GHCR_TOKEN env var. See the deploy step.
param ghcrToken = readEnvironmentVariable('GHCR_TOKEN')

// 33 internal-sidecar vendors. image = ghcr.io/wyre-technology/<slug>-mcp
// @ the :latest digest resolved 2026-05-20.
param vendors = [
  { slug: 'action1',      image: 'ghcr.io/wyre-technology/action1-mcp@sha256:4ead5f3cdbe70e8bbbbcee0afd1171873d2e6c779d789715b90a26e14013f5dd' }
  { slug: 'atera',        image: 'ghcr.io/wyre-technology/atera-mcp@sha256:dbdf9f645618be6e49c644c7b9066b2bbb7d40ce5dfbc63b39e6a65d0c667726' }
  { slug: 'autotask',     image: 'ghcr.io/wyre-technology/autotask-mcp@sha256:9de155d65771464c650850bc360bcb5bf42edb0dab9dc7053f0deafe33aaa31b' }
  { slug: 'avanan',       image: 'ghcr.io/wyre-technology/avanan-mcp@sha256:98b6fbd07c2723a4a853d737df387f6184ec67b86655f3b0c5e685949ce7caba' }
  { slug: 'blackpoint',   image: 'ghcr.io/wyre-technology/blackpoint-mcp@sha256:0d701df542e25b108dbf583fb9f648df414518af508728eb1af0e45486388220' }
  { slug: 'blumira',      image: 'ghcr.io/wyre-technology/blumira-mcp@sha256:3b4fbfff0871ff78f23121d2f4a8a611971381c82d984ee27df5932628a0f7cc' }
  { slug: 'cipp',         image: 'ghcr.io/wyre-technology/cipp-mcp@sha256:cfed349d884619c2afb3eb260300942a30f6d8c7adf83e56cfd1d2d8926c936f' }
  { slug: 'crewhu',       image: 'ghcr.io/wyre-technology/crewhu-mcp@sha256:43f4ff7df7b8bb5636fafa11085e9ace00dd718c8fde61efdb41af1de85575af' }
  { slug: 'domotz',       image: 'ghcr.io/wyre-technology/domotz-mcp@sha256:5df26854efe9abf3e4fc1e8fb1f7210e503290dfe500f571046c7f09213ca4fc' }
  { slug: 'halopsa',      image: 'ghcr.io/wyre-technology/halopsa-mcp@sha256:09c1393a53e453b4510958eeafa05583e041527a24b8d5850c704d262b10a1e4' }
  { slug: 'hudu',         image: 'ghcr.io/wyre-technology/hudu-mcp@sha256:b6a452fc80a58be84ff207e2dc2a01b14deb8e4b3dda7fecf545d13f91776087' }
  { slug: 'huntress',     image: 'ghcr.io/wyre-technology/huntress-mcp@sha256:b58f0ad611adbb39b46416f8cae003b538a07f18e8c5f075d56b99fd7fc882a1' }
  { slug: 'immybot',      image: 'ghcr.io/wyre-technology/immybot-mcp@sha256:4956748447b1f2fd8c4045a78d5db9ce9ef357cd78b88f87474a575251855b63' }
  { slug: 'ironscales',   image: 'ghcr.io/wyre-technology/ironscales-mcp@sha256:c4058b0479baf5e8f28be4dbe395d798924a516022fa6dfd2d529683f74718f8' }
  { slug: 'itglue',       image: 'ghcr.io/wyre-technology/itglue-mcp@sha256:6555e41c050a42feaf34cc1df50cf35f8ca5fcdd50dc742df7220c0fc42f01f6' }
  { slug: 'knowbe4',      image: 'ghcr.io/wyre-technology/knowbe4-mcp@sha256:b03ff043f9350bcaf893b7613048b6912c7950870c2cc0f2accc2edce563c7fa' }
  { slug: 'liongard',     image: 'ghcr.io/wyre-technology/liongard-mcp@sha256:b4630aef59016211e1a5a98dccd3d80739881a0365ba19e9f121177b21ca296d' }
  { slug: 'mimecast',     image: 'ghcr.io/wyre-technology/mimecast-mcp@sha256:4e41806a0cdf6ff87259cddfca71b1c69655f6279f82030d7fbb98bd0eb1e59a' }
  { slug: 'ninjaone',     image: 'ghcr.io/wyre-technology/ninjaone-mcp@sha256:ef5a030194db69fc45498105029efdcb3753bebca6bb388e8268e054c4d988cf' }
  { slug: 'proofpoint',   image: 'ghcr.io/wyre-technology/proofpoint-mcp@sha256:334bec65c861ddd5ee7ebe978286401be082b6cb211f9e655a615ed2bec919b7' }
  { slug: 'qbo',          image: 'ghcr.io/wyre-technology/qbo-mcp@sha256:6ec7dca55e0d3a1d6be974c4c674fe29948636aaa7fb60496bf70ee911943da4' }
  { slug: 'rocketcyber',  image: 'ghcr.io/wyre-technology/rocketcyber-mcp@sha256:0bd06f86f2d3726299b11b69751c8dc3329f781ada30f25bf36cad9b69a763ee' }
  { slug: 'salesbuildr',  image: 'ghcr.io/wyre-technology/salesbuildr-mcp@sha256:563fb9a3e4333827dd7d7aad960402019ad7b6769002773c404a595de9e4044b' }
  { slug: 'sentinelone',  image: 'ghcr.io/wyre-technology/sentinelone-mcp@sha256:52682fabe24a284dd39875be2220600f38d743ac5209685ecd7bc985c727175b' }
  { slug: 'sherweb',      image: 'ghcr.io/wyre-technology/sherweb-mcp@sha256:daec9cf64cf0ca8d4d4f1977c1936fa8974d2124f7e69a5865240852c27a18e8' }
  { slug: 'spamtitan',    image: 'ghcr.io/wyre-technology/spamtitan-mcp@sha256:1b2a0d325dd331c5d24ba2b749e5002d13448e6032cf821e902f362559dff350' }
  { slug: 'spanning',     image: 'ghcr.io/wyre-technology/spanning-mcp@sha256:6949a7d0741326302da684cf81eac716015ca33ee6717707fd2966d3273f101f' }
  { slug: 'superops',     image: 'ghcr.io/wyre-technology/superops-mcp@sha256:52ea518a517772cc8f1f0a9ac2bea6e8d61a95d4f447e33c96b53e3618c20260' }
  { slug: 'syncro',       image: 'ghcr.io/wyre-technology/syncro-mcp@sha256:055421cd80572459baca44e5cf01e68ed5c52b60786deec8774bd689568089c7' }
  { slug: 'threatlocker', image: 'ghcr.io/wyre-technology/threatlocker-mcp@sha256:52a11c22636f7d12c665a3eb36345c4577e2a49c621ae8c26dcd5c58ddfdcf5e' }
  { slug: 'timezest',     image: 'ghcr.io/wyre-technology/timezest-mcp@sha256:8cb1f6f5c46a076e856ed5f77b0b7030220e3838240aa7124717bf4c9ff7ed8b' }
  { slug: 'unitrends',    image: 'ghcr.io/wyre-technology/unitrends-mcp@sha256:8c44f88afa2c3a3ef243da1224de76e7d096b5ff1cb7252f8fee639607d36499' }
  { slug: 'xero',         image: 'ghcr.io/wyre-technology/xero-mcp@sha256:7961283583009e9c783bd34f802af3ab0a9ea93961dc96b9c08de5fc376f08ff' }
]
