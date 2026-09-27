import { SentEmailRow } from "@/types";
import { EmptyState, LoadingRows, StatusBadge, Table, Thead } from "../ui/Table";

export function SentTable({ rows, loading }: { rows: SentEmailRow[]; loading: boolean }) {
  return (
    <Table>
      <Thead columns={["Email", "Subject", "Sent time", "Status"]} />
      <tbody>
        {loading && <LoadingRows />}
        {!loading &&
          rows.map((row) => (
            <tr key={row.id} className="border-t border-slate-100 hover:bg-slate-50">
              <td className="px-4 py-3">{row.recipient}</td>
              <td className="px-4 py-3">{row.subject}</td>
              <td className="px-4 py-3 text-slate-500">
                {row.sentAt ? new Date(row.sentAt).toLocaleString() : "—"}
              </td>
              <td className="px-4 py-3">
                <StatusBadge status={row.status} />
                {row.status === "FAILED" && row.lastError && (
                  <span className="ml-2 text-xs text-red-500">{row.lastError}</span>
                )}
              </td>
            </tr>
          ))}
      </tbody>
      {!loading && rows.length === 0 && (
        <tfoot>
          <tr>
            <td colSpan={4}>
              <EmptyState title="No sent emails yet" subtitle="Sent emails will show up here." />
            </td>
          </tr>
        </tfoot>
      )}
    </Table>
  );
}
