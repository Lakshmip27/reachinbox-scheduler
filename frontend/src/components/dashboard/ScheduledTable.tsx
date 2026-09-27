import { ScheduledEmailRow } from "@/types";
import { EmptyState, LoadingRows, StatusBadge, Table, Thead } from "../ui/Table";

export function ScheduledTable({
  rows,
  loading,
}: {
  rows: ScheduledEmailRow[];
  loading: boolean;
}) {
  return (
    <Table>
      <Thead columns={["Email", "Subject", "Scheduled time", "Status"]} />
      <tbody>
        {loading && <LoadingRows />}
        {!loading &&
          rows.map((row) => (
            <tr key={row.id} className="border-t border-slate-100 hover:bg-slate-50">
              <td className="px-4 py-3">{row.recipient}</td>
              <td className="px-4 py-3">{row.subject}</td>
              <td className="px-4 py-3 text-slate-500">
                {new Date(row.scheduledAt).toLocaleString()}
              </td>
              <td className="px-4 py-3">
                <StatusBadge status={row.status} />
              </td>
            </tr>
          ))}
      </tbody>
      {!loading && rows.length === 0 && (
        <tfoot>
          <tr>
            <td colSpan={4}>
              <EmptyState
                title="No scheduled emails yet"
                subtitle="Compose a new email to schedule your first send."
              />
            </td>
          </tr>
        </tfoot>
      )}
    </Table>
  );
}
