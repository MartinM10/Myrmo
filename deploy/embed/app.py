"""Embedding service with a Text Embeddings Inference compatible API.

POST /embed {"inputs": str | [str], "normalize": bool, "truncate": bool} -> [[float]]
POST /task/embed  the same, with the task model (EMBED_TASK_MODEL), when one is set: a private colony's second index,
                  which matches what a person asks the agent to do ("despliega un tenant nuevo") in any language.

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

TASK_MODEL = os.environ.get("EMBED_TASK_MODEL", "").strip()
CACHE = os.environ.get("EMBED_CACHE", "/models")

model = TextEmbedding(MODEL, threads=THREADS, cache_dir=CACHE)
task_model = TextEmbedding(TASK_MODEL, threads=THREADS, cache_dir=CACHE) if TASK_MODEL else None
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
task_queue: asyncio.Queue[Job] = asyncio.Queue()


def _embedder(which: TextEmbedding):
    def run(texts: list[str]) -> np.ndarray:
        return np.asarray(list(which.embed(texts, batch_size=MAX_BATCH)), dtype=np.float32)

    return run


async def batcher(queue: asyncio.Queue[Job], _embed) -> None:
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
    asyncio.create_task(batcher(queue, _embedder(model)))
    if task_model is not None:
        asyncio.create_task(batcher(task_queue, _embedder(task_model)))


async def _answer(req: EmbedRequest, into: asyncio.Queue[Job]) -> list[list[float]]:
    texts = [req.inputs] if isinstance(req.inputs, str) else req.inputs
    if not texts or len(texts) > MAX_INPUTS:
        raise HTTPException(status_code=413, detail=f"1 to {MAX_INPUTS} inputs per request")
    future = asyncio.get_running_loop().create_future()
    await into.put(Job(texts, future))
    vectors = await future
    if req.normalize:
        vectors = vectors / np.maximum(np.linalg.norm(vectors, axis=1, keepdims=True), 1e-12)
    return vectors.tolist()


@app.post("/embed")
async def embed(req: EmbedRequest) -> list[list[float]]:
    return await _answer(req, queue)


@app.post("/task/embed")
async def embed_task(req: EmbedRequest) -> list[list[float]]:
    if task_model is None:
        raise HTTPException(status_code=404, detail="no task model: set EMBED_TASK_MODEL")
    return await _answer(req, task_queue)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "model": MODEL, "task_model": TASK_MODEL or "none"}


@app.get("/task/health")
async def task_health() -> dict[str, str]:
    if task_model is None:
        raise HTTPException(status_code=404, detail="no task model: set EMBED_TASK_MODEL")
    return {"status": "ok", "model": TASK_MODEL}
