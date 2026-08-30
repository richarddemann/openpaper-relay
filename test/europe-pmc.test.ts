import assert from "node:assert/strict";
import test from "node:test";
import { EuropePmcClient } from "../src/europe-pmc.js";
import { makePdf } from "./fixture.js";

const openPaper = {
  id: "22253597",
  source: "MED",
  pmid: "22253597",
  pmcid: "PMC3257301",
  doi: "10.1371/journal.ppat.1002485",
  title: "The bZIP transcription factor Rca1p is a central regulator.",
  authorString: "Cottier F, Raymond M.",
  pubYear: "2012",
  journalInfo: { journal: { title: "PLoS Pathogens" } },
  fullTextUrlList: {
    fullTextUrl: [
      {
        availability: "Open access",
        availabilityCode: "OA",
        documentStyle: "html",
        site: "Europe_PMC",
        url: "https://europepmc.org/articles/PMC3257301?token=do-not-return#reader",
      },
      {
        availability: "Open access",
        availabilityCode: "OA",
        documentStyle: "pdf",
        site: "Europe_PMC",
        url: "https://europepmc.org/articles/PMC3257301?pdf=render",
      },
      {
        availability: "Open access",
        availabilityCode: "OA",
        documentStyle: "pdf",
        site: "Untrusted",
        url: "https://attacker.example/paper.pdf",
      },
      {
        availability: "Open access",
        availabilityCode: "OA",
        documentStyle: "pdf",
        site: "Europe_PMC",
        url: "https://europepmc.org/articles/PMC9999999?pdf=render",
      },
    ],
  },
  isOpenAccess: "Y",
  hasPDF: "Y",
  license: "cc by",
};

function searchResponse(results = [openPaper]): Response {
  return Response.json({ resultList: { result: results } });
}

test("search returns normalized PubMed metadata and opaque open-PDF versions", async () => {
  const requested: URL[] = [];
  const client = new EuropePmcClient(30_000_000, async (input) => {
    requested.push(new URL(String(input)));
    return searchResponse();
  });

  const result = await client.search("Rca1p central regulator");

  assert.equal(requested[0]?.hostname, "www.ebi.ac.uk");
  assert.equal(requested[0]?.searchParams.get("pageSize"), "5");
  assert.equal(result.candidates[0]?.metadata.doi, "10.1371/journal.ppat.1002485");
  assert.equal(result.candidates[0]?.metadata.journal, "PLoS Pathogens");
  assert.deepEqual(result.candidates[0]?.versions, [
    {
      versionId: "PMC3257301:pdf:85dcb65fed8911fff9cb627ca2501c5cd7db1fe68578f5aa3c4e7841d11c27de",
      label: "Europe PMC open-access PDF",
      license: "cc by",
      source: "Europe PMC",
      landingPage: "https://europepmc.org/articles/PMC3257301",
    },
  ]);
});

test("download re-resolves an opaque version and accepts only the fixed Europe PMC host", async () => {
  const pdf = makePdf("Europe PMC fixture");
  const requested: URL[] = [];
  const client = new EuropePmcClient(30_000_000, async (input) => {
    const url = new URL(String(input));
    requested.push(url);
    if (url.hostname === "www.ebi.ac.uk") return searchResponse();
    if (url.pathname === "/articles/PMC3257301") {
      return new Response(null, {
        status: 302,
        headers: { location: "https://europepmc.org/api/getPdf?pmcid=PMC3257301" },
      });
    }
    return new Response(pdf, {
      headers: {
        "content-type": "application/pdf",
        "content-length": String(pdf.byteLength),
        "content-disposition": "inline; filename=article.pdf",
      },
    });
  });

  const result = await client.download("PMC3257301:pdf:85dcb65fed8911fff9cb627ca2501c5cd7db1fe68578f5aa3c4e7841d11c27de");

  assert.equal(result.filename, "article.pdf");
  assert.deepEqual(result.data, pdf);
  assert.deepEqual(requested.map((url) => url.hostname), ["www.ebi.ac.uk", "europepmc.org", "europepmc.org"]);
});

test("download rejects caller-supplied URLs and non-open versions", async () => {
  const client = new EuropePmcClient(30_000_000, async () => searchResponse([{ ...openPaper, isOpenAccess: "N" }]));
  await assert.rejects(client.download("https://attacker.example/paper.pdf"), /invalid Europe PMC version_id/);
  await assert.rejects(
    client.download("PMC3257301:pdf:85dcb65fed8911fff9cb627ca2501c5cd7db1fe68578f5aa3c4e7841d11c27de"),
    /no longer available/,
  );
});

test("download enforces the configured byte limit before reading the PDF", async () => {
  const client = new EuropePmcClient(1_000, async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "www.ebi.ac.uk") return searchResponse();
    return new Response(makePdf("too large"), {
      headers: { "content-type": "application/pdf", "content-length": "1001" },
    });
  });
  await assert.rejects(
    client.download("PMC3257301:pdf:85dcb65fed8911fff9cb627ca2501c5cd7db1fe68578f5aa3c4e7841d11c27de"),
    /exceeds configured size limit/,
  );
});

test("metadata and PDF requests reject redirects outside their fixed origins", async () => {
  const metadataRedirect = new EuropePmcClient(30_000_000, async () =>
    new Response(null, { status: 302, headers: { location: "https://attacker.example/results" } })
  );
  await assert.rejects(metadataRedirect.search("paper title"), /metadata request returned an unexpected redirect/);

  const pdfRedirect = new EuropePmcClient(30_000_000, async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "www.ebi.ac.uk") return searchResponse();
    return new Response(null, { status: 302, headers: { location: "https://attacker.example/paper.pdf" } });
  });
  await assert.rejects(
    pdfRedirect.download("PMC3257301:pdf:85dcb65fed8911fff9cb627ca2501c5cd7db1fe68578f5aa3c4e7841d11c27de"),
    /outside its fixed HTTPS origin/,
  );
});

test("PDF redirects cannot switch to another PMCID on the trusted origin", async () => {
  const client = new EuropePmcClient(30_000_000, async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "www.ebi.ac.uk") return searchResponse();
    return new Response(null, {
      status: 302,
      headers: { location: "https://europepmc.org/api/getPdf?pmcid=PMC9999999" },
    });
  });
  await assert.rejects(
    client.download("PMC3257301:pdf:85dcb65fed8911fff9cb627ca2501c5cd7db1fe68578f5aa3c4e7841d11c27de"),
    /does not match the selected PMCID/,
  );
});

test("a version ID follows its URL fingerprint rather than a mutable list position", async () => {
  const reordered = structuredClone(openPaper);
  reordered.fullTextUrlList.fullTextUrl.splice(1, 0, {
    availability: "Open access",
    availabilityCode: "OA",
    documentStyle: "pdf",
    site: "Europe_PMC",
    url: "https://europepmc.org/articles/PMC3257301?pdf=supplement",
  });
  const pdf = makePdf("stable version");
  let selectedPdfUrl: URL | undefined;
  const client = new EuropePmcClient(30_000_000, async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "www.ebi.ac.uk") return searchResponse([reordered]);
    selectedPdfUrl = url;
    return new Response(pdf, {
      headers: { "content-type": "application/pdf", "content-length": String(pdf.byteLength) },
    });
  });

  const downloaded = await client.download(
    "PMC3257301:pdf:85dcb65fed8911fff9cb627ca2501c5cd7db1fe68578f5aa3c4e7841d11c27de",
  );
  assert.deepEqual(downloaded.data, pdf);
  assert.equal(selectedPdfUrl?.searchParams.get("pdf"), "render");
});
