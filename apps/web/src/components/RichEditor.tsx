import { useRef } from 'react';
import { useEditor, EditorContent, Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';

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
  editor,
  onClick,
  active,
  label,
}: {
  editor: Editor;
  onClick: () => void;
  active?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={`px-2 py-0.5 text-xs rounded ${
        active
          ? 'bg-blue-600 text-white'
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
  const fileRef = useRef<HTMLInputElement>(null);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Image,
      Link.configure({ openOnClick: false }),
    ],
    content,
    onUpdate: ({ editor }) => onChange(editor.getHTML()),
  });

  if (!editor) return null;

  const pickImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !onUploadImage) return;
    try {
      const url = await onUploadImage(file);
      editor.chain().focus().setImage({ src: url }).run();
    } catch {
      alert('图片上传失败');
    }
  };

  return (
    <div className="rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800">
      <div className="flex flex-wrap gap-1 border-b border-gray-200 dark:border-gray-700 p-1">
        <Btn editor={editor} label="B" active={editor.isActive('bold')}
          onClick={() => editor.chain().focus().toggleBold().run()} />
        <Btn editor={editor} label="I" active={editor.isActive('italic')}
          onClick={() => editor.chain().focus().toggleItalic().run()} />
        <Btn editor={editor} label="H1" active={editor.isActive('heading', { level: 1 })}
          onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} />
        <Btn editor={editor} label="H2" active={editor.isActive('heading', { level: 2 })}
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} />
        <Btn editor={editor} label="• 列表" active={editor.isActive('bulletList')}
          onClick={() => editor.chain().focus().toggleBulletList().run()} />
        <Btn editor={editor} label="1. 列表" active={editor.isActive('orderedList')}
          onClick={() => editor.chain().focus().toggleOrderedList().run()} />
        <Btn editor={editor} label="引用" active={editor.isActive('blockquote')}
          onClick={() => editor.chain().focus().toggleBlockquote().run()} />
        <Btn editor={editor} label="代码块" active={editor.isActive('codeBlock')}
          onClick={() => editor.chain().focus().toggleCodeBlock().run()} />
        {onUploadImage && (
          <Btn editor={editor} label="🖼 图片"
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
        data-placeholder={placeholder}
      />
    </div>
  );
}
