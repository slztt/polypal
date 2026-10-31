"""
PolyPal FastAPI backend.
Runs locally within the Electron app to provide AI inference endpoints.
"""
import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi import HTTPException

from services.stdio_utf8 import ensure_utf8_stdio
ensure_utf8_stdio()  # must run before any print/logging hits the pipe

from routers import generation, model, optimize, status, settings, extensions, export, workflow_runs, agent, llm, edit, gpu, library, skills, texture, images
from services.app_info import APP_NAME, APP_VERSION


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: initialize the registry (instantiates all adapters)
    from services.generator_registry import generator_registry
    generator_registry.initialize()
    # Unload 3D generators left idle past the GPU policy's limit.
    from services.gpu import reaper
    reaper.start(gpu.reap_idle_generators)
    yield
    # Shutdown: unload all models and stop the local LLM server
    generator_registry.unload_all()
    from services.llm_server import llama_pool
    llama_pool.unload_all(force=True)


class _StatusFilter(logging.Filter):
    def filter(self, record):
        # Endpoints the UI polls every few seconds would drown the log.
        message = record.getMessage()
        return not any(path in message for path in ("/generate/status/", "/generate/queue", "/gpu/status"))

logging.getLogger("uvicorn.access").addFilter(_StatusFilter())


app = FastAPI(
    title=f"{APP_NAME} API",
    version=APP_VERSION,
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    # drei's SplatLoader reads Content-Length to size its buffers; cross-origin
    # JS can only see it when the server explicitly exposes the header.
    expose_headers=["Content-Length"],
)

app.include_router(status.router)
app.include_router(settings.router)
app.include_router(model.router,      prefix="/model")
app.include_router(generation.router, prefix="/generate")
app.include_router(optimize.router,    prefix="/optimize")
app.include_router(extensions.router, prefix="/extensions")
app.include_router(export.router,          prefix="/export")
app.include_router(workflow_runs.router,   prefix="/workflow-runs")
app.include_router(agent.router)
app.include_router(llm.router,             prefix="/llm")
app.include_router(edit.router)
app.include_router(gpu.router)
app.include_router(library.router)
app.include_router(skills.router)
app.include_router(texture.router)
app.include_router(images.router)

# Serve generated files from workspace — dynamic so path changes take effect immediately
@app.get("/workspace/{full_path:path}")
async def serve_workspace_file(full_path: str):
    import services.generator_registry as reg
    file_path = reg.WORKSPACE_DIR / full_path
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(str(file_path))
