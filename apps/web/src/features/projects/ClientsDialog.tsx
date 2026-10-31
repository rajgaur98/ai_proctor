// Add, rename and archive clients (#38, PRJ-01).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ExportButton } from "../../components/ExportButton";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { type Client, clientsQuery, projectsQuery, saveClient } from "./projectData";

export function ClientsDialog({ onClose }: { onClose: () => void }) {
  const { data, error, isPending } = useQuery(clientsQuery);
  const clients = data ?? [];
  const projects = useQuery(projectsQuery).data ?? [];

  return (
    <dialog
      ref={(el) => {
        if (el && !el.open) el.showModal();
      }}
      onClose={onClose}
      aria-labelledby="clients-title"
      className="m-auto w-[min(520px,calc(100vw-32px))] rounded-xl border border-line bg-panel p-6 text-ink backdrop:bg-black/30"
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <h2 id="clients-title" className="text-lg font-semibold">
            Clients
          </h2>
          <ExportButton
            title="Clients"
            className="ml-auto h-9"
            ready={!isPending && !error}
            spec={{
              page: "clients",
              filters: {},
              table: () => ({
                sheet: "Clients",
                header: ["Client", "Projects", "Status"],
                rows: clients.map((c) => [
                  c.name,
                  projects.filter((p) => p.clientId === c.id).length,
                  c.archived ? "Archived" : "Active",
                ]),
              }),
            }}
          />
        </div>
        {error ? (
          <p role="alert" className="text-sm text-warnink">
            Couldn't load clients: {error.message}
          </p>
        ) : isPending ? (
          <p className="text-sm text-ink2">Loading…</p>
        ) : clients.length === 0 ? (
          <p className="text-sm text-ink2">No clients yet.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {clients.map((c) => (
              <ClientRow key={c.id} client={c} />
            ))}
          </ul>
        )}
        <AddClient />
        <div className="flex">
          <Button type="button" variant="secondary" className="ml-auto" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </dialog>
  );
}

function useSaveClient(onDone?: () => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string | null; name: string; archived: boolean }) =>
      saveClient(v.id, v.name, v.archived),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: clientsQuery.queryKey });
      queryClient.invalidateQueries({ queryKey: projectsQuery.queryKey });
      onDone?.();
    },
  });
}

function ClientRow({ client }: { client: Client }) {
  const [name, setName] = useState(client.name);
  const save = useSaveClient();

  return (
    <li className="flex flex-col gap-1.5">
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate({ id: client.id, name, archived: client.archived });
        }}
      >
        <Input
          aria-label={`Name of ${client.name}`}
          required
          maxLength={120}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Button
          type="submit"
          variant="secondary"
          className="h-11 shrink-0"
          disabled={save.isPending || name.trim() === client.name}
        >
          Rename
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="h-11 shrink-0"
          disabled={save.isPending}
          onClick={() =>
            save.mutate({ id: client.id, name: client.name, archived: !client.archived })
          }
        >
          {client.archived ? "Restore" : "Archive"}
        </Button>
      </form>
      {client.archived && <span className="text-xs text-ink3">Archived</span>}
      {save.error && (
        <p role="alert" className="text-sm text-warnink">
          {save.error.message}
        </p>
      )}
    </li>
  );
}

function AddClient() {
  const [name, setName] = useState("");
  const save = useSaveClient(() => setName(""));

  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate({ id: null, name, archived: false });
      }}
    >
      <div className="flex items-center gap-2">
        <Input
          aria-label="New client name"
          placeholder="New client name"
          required
          maxLength={120}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Button type="submit" className="shrink-0" disabled={save.isPending}>
          Add client
        </Button>
      </div>
      {save.error && (
        <p role="alert" className="text-sm text-warnink">
          {save.error.message}
        </p>
      )}
    </form>
  );
}
