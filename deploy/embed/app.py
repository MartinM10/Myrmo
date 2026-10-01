"""Embedding service with a Text Embeddings Inference compatible API.

POST /embed {"inputs": str | [str], "normalize": bool, "truncate": bool} -> [[float]]

Runs anywhere ONNX Runtime does (x86_64 and arm64). Concurrent requests are grouped
into micro-batches, which is where most of the throughput comes from.
"""

from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass

import numpy as np
from fastapi import FastAPI, HTTPException
from fastembed import TextEmbedding
from pydantic import BaseModel

MODEL = os.environ.get("EMBED_MODEL", "BAAI/bge-small-en-v1.5")
THREADS = int(os.environ.get("EMBED_THREADS", "0")) or None
MAX_BATCH = int(os.environ.get("EMBED_MAX_BATCH", "64"))
WINDOW_S = float(os.environ.get("EMBED_BATCH_WINDOW_MS", "3")) / 1000
MAX_INPUTS = 64

model = TextEmbedding(MODEL, threads=THREADS, cache_dir=os.environ.get("EMBED_CACHE", "/models"))
app = FastAPI(title="myrmo-embed")


class EmbedRequest(BaseModel):
    inputs: str | list[str]
    normalize: bool = True
    truncate: bool = True


@dataclass
class Job:
    texts: list[str]
    future: asyncio.Future


queue: asyncio.Queue[Job] = asyncio.Queue()


def _embed(texts: list[str]) -> np.ndarray:
    return np.asarray(list(model.embed(texts, batch_size=MAX_BATCH)), dtype=np.float32)


async def batcher() -> None:
    loop = asyncio.get_running_loop()
    while True:
        jobs = [await queue.get()]
        size = len(jobs[0].texts)
        deadline = loop.time() + WINDOW_S
        while size < MAX_BATCH:
            timeout = deadline - loop.time()
            if timeout <= 0:
                break
            try:
                job = await asyncio.wait_for(queue.get(), timeout)
            except asyncio.TimeoutError:
                break
            jobs.append(job)
            size += len(job.texts)
        texts = [t for job in jobs for t in job.texts]
        try:
            vectors = await asyncio.to_thread(_embed, texts)
        except Exception as exc:  # propagate to every waiting request
            for job in jobs:
                job.future.set_exception(exc)
            continue
        offset = 0
        for job in jobs:
            job.future.set_result(vectors[offset : offset + len(job.texts)])
            offset += len(job.texts)


@app.on_event("startup")
async def start_batcher() -> None:
    asyncio.create_task(batcher())


@app.post("/embed")
async def embed(req: EmbedRequest) -> list[list[float]]:
    texts = [req.inputs] if isinstance(req.inputs, str) else req.inputs
    if not texts or len(texts) > MAX_INPUTS:
        raise HTTPException(status_code=413, detail=f"1 to {MAX_INPUTS} inputs per request")
    future = asyncio.get_running_loop().create_future()
    await queue.put(Job(texts, future))
    vectors = await future
    if req.normalize:
        vectors = vectors / np.maximum(np.linalg.norm(vectors, axis=1, keepdims=True), 1e-12)
    return vectors.tolist()


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "model": MODEL}
