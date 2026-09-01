import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';

interface Props {
  onChange: (html: string) => void;
  content?: string;
  placeholder?: string;
  /** 编辑区最小高度（px），默认 100 */
  minHeight?: number;
  /** 上传图片，返回可访问 URL；提供时显示插图按钮 */
  onUploadImage?: (file: File) => Promise<string>;
}

function Btn({
  onClick,
  active,
  label,
  title,
}: {
  onClick: () => void;
  active?: boolean;
  label: string;
  /** Accessible name — B / I / H1 mean nothing to a screen reader */
  title: string;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={!!active}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={`px-2 py-0.5 text-xs rounded ${
        active
          ? 'bg-brand-700 text-white'
          : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
      }`}
    >
      {label}
    </button>
  );
}

export default function RichEditor({
  onChange,
  content = '',
  placeholder,
  minHeight = 100,
  onUploadImage,
}: Props) {
  const { t } = useTranslation();
  const [dragging, setDragging] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const uploadRef = useRef(onUploadImage);
  uploadRef.current = onUploadImage;
  // 编辑器只初始化一次，而占位符会随语言切换变化，所以走 ref 读最新值
  const placeholderRef = useRef(placeholder);
  placeholderRef.current = placeholder;

  // 上传图片并在光标处插入
  const uploadAndInsert = async (file: File) => {
    const up = uploadRef.current;
    if (!up) return;
    try {
      setUploadError(null);
      const url = await up(file);
      editorRef.current?.chain().focus().setImage({ src: url }).run();
    } catch {
      // 原先用 alert：它会阻塞整个页面，用户还得先点掉才能继续写单子
      setUploadError(t('editor.errUploadFailed'));
    }
  };

  // 从粘贴/拖拽事件里取出图片文件
  const imagesFrom = (list?: FileList | null) =>
    list ? Array.from(list).filter((f) => f.type.startsWith('image/')) : [];

  /**
   * 拖的是不是文件。dragover 阶段读不到 files（浏览器出于安全不暴露），
   * 只能看 types 里有没有 'Files'——拖选中的文字时就不该亮高亮。
   */
  const hasFiles = (e: React.DragEvent) =>
    Array.from(e.dataTransfer.types).includes('Files');

  const editor = useEditor({
    extensions: [
      StarterKit,
      Image,
      Link.configure({ openOnClick: false }),
      // 占位符必须由扩展渲染：它负责给空段落加 is-editor-empty 和
      // data-placeholder，CSS 的 attr(data-placeholder) 才取得到值。
      // 之前把 data-placeholder 挂在外层容器上，attr() 读不到，占位符从来没显示过。
      Placeholder.configure({ placeholder: () => placeholderRef.current ?? '' }),
    ],
    content,
    onUpdate: ({ editor }) => onChange(editor.getHTML()),
    editorProps: {
      // 粘贴截图/图片 → 自动上传插入
      handlePaste: (_v, event) => {
        const imgs = imagesFrom(event.clipboardData?.files);
        if (imgs.length && uploadRef.current) {
          imgs.forEach((f) => uploadAndInsert(f));
          return true;
        }
        return false;
      },
      // 拖拽不在这里处理，见下方 onDrop：ProseMirror 的 handleDrop 依赖
      // posAtCoords 解析出文档位置，落在空编辑器下方的大片空白时解析不出来，
      // 回调根本不触发——表现就是「有时能拖有时不能」。改在容器上接。
    },
  });
  editorRef.current = editor;

  if (!editor) return null;

  const pickImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) await uploadAndInsert(file);
  };

  return (
    <div
      onDragOver={(e) => {
        if (!uploadRef.current || !hasFiles(e)) return;
        e.preventDefault(); // 不拦默认行为浏览器会直接打开图片
        e.dataTransfer.dropEffect = 'copy';
        if (!dragging) setDragging(true);
      }}
      onDragLeave={(e) => {
        // 只在真正离开整个编辑器时收起高亮，在子元素间移动不算
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={(e) => {
        if (!uploadRef.current || !hasFiles(e)) return;
        e.preventDefault();
        setDragging(false);
        imagesFrom(e.dataTransfer.files).forEach((f) => uploadAndInsert(f));
      }}
      className={`rounded-md border bg-white dark:bg-gray-800 ${
        dragging
          ? 'border-brand-600 ring-2 ring-brand-500/30'
          : 'border-gray-300 dark:border-gray-700'
      }`}
    >
      <div className="flex flex-wrap gap-1 border-b border-gray-200 dark:border-gray-700 p-1">
        <Btn label="B" title={t('editor.bold')} active={editor.isActive('bold')}
          onClick={() => editor.chain().focus().toggleBold().run()} />
        <Btn label="I" title={t('editor.italic')} active={editor.isActive('italic')}
          onClick={() => editor.chain().focus().toggleItalic().run()} />
        <Btn label="H1" title={t('editor.heading1')} active={editor.isActive('heading', { level: 1 })}
          onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} />
        <Btn label="H2" title={t('editor.heading2')} active={editor.isActive('heading', { level: 2 })}
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} />
        <Btn label={t('editor.bulletList')} title={t('editor.bulletList')} active={editor.isActive('bulletList')}
          onClick={() => editor.chain().focus().toggleBulletList().run()} />
        <Btn label={t('editor.orderedList')} title={t('editor.orderedList')} active={editor.isActive('orderedList')}
          onClick={() => editor.chain().focus().toggleOrderedList().run()} />
        <Btn label={t('editor.quote')} title={t('editor.quote')} active={editor.isActive('blockquote')}
          onClick={() => editor.chain().focus().toggleBlockquote().run()} />
        <Btn label={t('editor.codeBlock')} title={t('editor.codeBlock')} active={editor.isActive('codeBlock')}
          onClick={() => editor.chain().focus().toggleCodeBlock().run()} />
        {onUploadImage && (
          <Btn label={t('editor.image')} title={t('editor.image')}
            onClick={() => fileRef.current?.click()} />
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={pickImage}
        />
      </div>
      <EditorContent
        editor={editor}
        className="tiptap px-3 py-2 text-sm overflow-auto"
        style={{ minHeight, maxHeight: 520 }}
      />
      {uploadError && (
        <p className="border-t border-gray-200 px-3 py-1.5 text-xs text-red-500 dark:border-gray-700">
          {uploadError}
        </p>
      )}
    </div>
  );
}
